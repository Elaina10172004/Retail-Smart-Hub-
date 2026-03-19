import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const windowsShell = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : null;
const electronCommand = process.platform === 'win32'
  ? path.join(appDir, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(appDir, 'node_modules', '.bin', 'electron');
const electronEntry = path.join(appDir, 'electron', 'main.cjs');
const children = [];
let shuttingDown = false;

function stopProcessTree(pid) {
  if (!pid) {
    return;
  }

  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // ignore child process termination race conditions
  }
}

function shutdown(code = 0) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  for (const child of children) {
    stopProcessTree(child.pid);
  }

  setTimeout(() => process.exit(code), 400);
}

function startTask(label, args) {
  const child = process.platform === 'win32'
    ? spawn(windowsShell, ['/d', '/s', '/c', npmCommand, ...args], {
        cwd: appDir,
        stdio: 'inherit',
        windowsHide: false,
      })
    : spawn(npmCommand, args, {
        cwd: appDir,
        stdio: 'inherit',
        windowsHide: false,
      });

  children.push(child);

  child.on('exit', (code, signal) => {
    if (shuttingDown) {
      return;
    }

    const reason = signal ? `signal ${signal}` : `code ${code ?? 0}`;
    console.error(`[desktop-shell] ${label} exited with ${reason}.`);
    shutdown(code ?? 1);
  });
}

function startExternalTask(label, command, args, extraEnv = {}) {
  const env = {
    ...process.env,
  };

  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined || value === null) {
      delete env[key];
      continue;
    }

    env[key] = value;
  }

  const child = spawn(command, args, {
    cwd: appDir,
    stdio: 'inherit',
    windowsHide: false,
    env,
  });

  children.push(child);

  child.on('exit', (code, signal) => {
    if (shuttingDown) {
      return;
    }

    const reason = signal ? `signal ${signal}` : `code ${code ?? 0}`;
    console.error(`[desktop-shell] ${label} exited with ${reason}.`);
    shutdown(code ?? 1);
  });
}

function waitForHttp(url, timeoutMs = 120000) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const request = http.get(url, (response) => {
        response.resume();
        resolve(response.statusCode ?? 200);
      });

      request.on('error', () => {
        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error(`Timed out waiting for ${url}`));
          return;
        }

        setTimeout(tryConnect, 1000);
      });
    };

    tryConnect();
  });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log('[desktop-shell] starting API and Vite dev servers for Electron...');
startTask('api', ['run', 'dev:server']);
startTask('frontend', ['run', 'dev']);

try {
  await waitForHttp('http://127.0.0.1:4000/api/system/session');
  console.log('[desktop-shell] API server is reachable on http://127.0.0.1:4000');

  await waitForHttp('http://127.0.0.1:3000');
  console.log('[desktop-shell] Frontend is reachable on http://127.0.0.1:3000');
} catch (error) {
  console.error(`[desktop-shell] ${error instanceof Error ? error.message : 'Failed to start dev servers.'}`);
  shutdown(1);
}

if (!shuttingDown) {
  startExternalTask('electron', electronCommand, [electronEntry], {
    RETAIL_SMART_HUB_START_URL: 'http://127.0.0.1:3000',
    RETAIL_SMART_HUB_API_URL: 'http://127.0.0.1:4000',
    RETAIL_SMART_HUB_DEV: 'true',
    ELECTRON_RUN_AS_NODE: null,
  });
}

setInterval(() => {
  if (!shuttingDown) {
    return;
  }
}, 1000);
