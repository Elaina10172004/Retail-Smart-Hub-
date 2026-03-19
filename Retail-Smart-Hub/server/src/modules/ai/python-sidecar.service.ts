import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { env } from '../../config/env';
import { resolveWorkspaceRoot } from './workspace-root';

let pythonProcess: ChildProcessWithoutNullStreams | null = null;
let sidecarStartPromise: Promise<void> | null = null;
let sidecarReady = false;
let pythonDepsChecked = false;
let pythonStdoutBuffer = '';
let pythonStderrBuffer = '';

function isPythonRuntimeEnabled() {
  return env.aiRuntime === 'python';
}

function resolvePythonEntry() {
  if (env.aiPythonEntry) {
    return env.aiPythonEntry;
  }

  const candidates = [
    path.resolve(process.cwd(), 'python-agent', 'main.py'),
    path.resolve(__dirname, '../../../../python-agent/main.py'),
    path.resolve(path.dirname(process.execPath), 'python-agent', 'main.py'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0];
}

function resolvePythonAgentDir(pythonEntry: string) {
  return path.dirname(pythonEntry);
}

function normalizePythonUtf8(value: string | undefined) {
  const normalized = String(value ?? '').trim();
  if (normalized === '0' || normalized === '1') {
    return normalized;
  }
  return '1';
}

function buildPythonEnv() {
  const normalizedUtf8 = normalizePythonUtf8(process.env.PYTHONUTF8);
  return {
    ...process.env,
    PYTHONIOENCODING: String(process.env.PYTHONIOENCODING ?? 'utf-8').trim() || 'utf-8',
    PYTHONUTF8: normalizedUtf8,
  };
}

function flushPythonLogBuffer(
  bufferRef: 'stdout' | 'stderr',
  chunk: string,
  logger: (line: string) => void,
) {
  const nextBuffer = bufferRef === 'stdout' ? pythonStdoutBuffer + chunk : pythonStderrBuffer + chunk;
  const normalized = nextBuffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  const tail = lines.pop() ?? '';

  for (const line of lines) {
    const text = line.trim();
    if (text) {
      logger(text);
    }
  }

  if (bufferRef === 'stdout') {
    pythonStdoutBuffer = tail;
  } else {
    pythonStderrBuffer = tail;
  }
}

function runPythonSync(commandArgs: string[], cwd: string) {
  const pythonEnv = buildPythonEnv();
  return spawnSync(env.aiPythonCommand, commandArgs, {
    cwd,
    env: pythonEnv,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function ensurePythonAgentDependencies(pythonEntry: string) {
  if (pythonDepsChecked) {
    return;
  }

  const pythonAgentDir = resolvePythonAgentDir(pythonEntry);
  const requirementsPath = path.join(pythonAgentDir, 'requirements.txt');
  if (!fs.existsSync(requirementsPath)) {
    pythonDepsChecked = true;
    return;
  }

  const checkResult = runPythonSync(['-c', 'import fastapi,uvicorn,pydantic,lancedb'], pythonAgentDir);
  if (checkResult.status === 0) {
    pythonDepsChecked = true;
    return;
  }

  console.warn('[python-agent] Python dependencies missing, installing requirements...');
  const installResult = runPythonSync(['-m', 'pip', 'install', '-r', requirementsPath], pythonAgentDir);
  if (installResult.status !== 0) {
    const stderr = installResult.stderr?.trim();
    const stdout = installResult.stdout?.trim();
    const details = stderr || stdout || 'Unknown pip install error';
    throw new Error(`Failed to install python-agent requirements: ${details}`);
  }

  const verifyResult = runPythonSync(['-c', 'import fastapi,uvicorn,pydantic,lancedb'], pythonAgentDir);
  if (verifyResult.status !== 0) {
    const stderr = verifyResult.stderr?.trim();
    const stdout = verifyResult.stdout?.trim();
    const details = stderr || stdout || 'Python dependency verification failed';
    throw new Error(`Python-agent dependency verification failed: ${details}`);
  }

  pythonDepsChecked = true;
}

function getNodeInternalAgentBaseUrl() {
  return `http://${env.host}:${env.port}/api/internal/agent`;
}

function getPythonWorkspaceRoot() {
  return resolveWorkspaceRoot();
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(timeoutMs = 20000) {
  const start = Date.now();
  const healthUrl = `http://${env.aiPythonHost}:${env.aiPythonPort}/internal/agent/health`;

  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(healthUrl, {
        headers: {
          'x-agent-key': env.aiAgentSharedKey,
        },
      });
      if (response.ok) {
        return;
      }
    } catch {
      // retry until timeout
    }
    await sleep(300);
  }

  throw new Error(`Python agent health check timed out after ${timeoutMs}ms`);
}

export async function ensurePythonSidecarStarted() {
  if (!isPythonRuntimeEnabled() || !env.aiPythonAutostart || process.env.NODE_ENV === 'test') {
    return;
  }

  if (sidecarReady) {
    return;
  }

  if (sidecarStartPromise) {
    return sidecarStartPromise;
  }

  sidecarStartPromise = (async () => {
    const pythonEntry = resolvePythonEntry();
    if (!fs.existsSync(pythonEntry)) {
      throw new Error(`Python agent entry not found: ${pythonEntry}`);
    }

    ensurePythonAgentDependencies(pythonEntry);

    if (!pythonProcess || pythonProcess.killed) {
      const pythonEnv = buildPythonEnv();
      pythonProcess = spawn(env.aiPythonCommand, [pythonEntry], {
        cwd: process.cwd(),
        env: {
          ...pythonEnv,
          AI_AGENT_HOST: env.aiPythonHost,
          AI_AGENT_PORT: String(env.aiPythonPort),
          AI_AGENT_SHARED_KEY: env.aiAgentSharedKey,
          RETAIL_SMART_HUB_WORKSPACE_ROOT: getPythonWorkspaceRoot(),
          NODE_INTERNAL_AGENT_BASE_URL: process.env.NODE_INTERNAL_AGENT_BASE_URL || getNodeInternalAgentBaseUrl(),
          NODE_INTERNAL_AGENT_KEY: env.aiAgentSharedKey,
        },
        stdio: 'pipe',
      });

      pythonProcess.stdout.setEncoding('utf8');
      pythonProcess.stderr.setEncoding('utf8');

      pythonProcess.stdout.on('data', (chunk) => {
        flushPythonLogBuffer('stdout', String(chunk), (line) => {
          console.log(`[python-agent] ${line}`);
        });
      });
      pythonProcess.stderr.on('data', (chunk) => {
        flushPythonLogBuffer('stderr', String(chunk), (line) => {
          console.error(`[python-agent] ${line}`);
        });
      });
      pythonProcess.on('exit', (code, signal) => {
        sidecarReady = false;
        sidecarStartPromise = null;
        pythonProcess = null;
        pythonStdoutBuffer = '';
        pythonStderrBuffer = '';
        console.error(`[python-agent] exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
      });
    }

    await waitForHealth();
    sidecarReady = true;
  })();

  try {
    await sidecarStartPromise;
  } finally {
    if (!sidecarReady) {
      sidecarStartPromise = null;
    }
  }
}

export function stopPythonSidecar() {
  if (!pythonProcess || pythonProcess.killed) {
    return;
  }

  try {
    pythonProcess.kill();
  } catch {
    // ignore
  } finally {
    pythonProcess = null;
    sidecarReady = false;
    sidecarStartPromise = null;
    pythonStdoutBuffer = '';
    pythonStderrBuffer = '';
  }
}

export async function restartPythonSidecar() {
  stopPythonSidecar();
  await ensurePythonSidecarStarted();
}

export function isPythonSidecarReady() {
  return sidecarReady;
}

