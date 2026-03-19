import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function requireFile(relativePath, reason) {
  if (!exists(relativePath)) {
    failures.push(`[required] ${relativePath} is missing (${reason})`);
    return null;
  }
  return read(relativePath);
}

function requireContains(relativePath, patterns, reason) {
  const content = requireFile(relativePath, reason);
  if (content === null) {
    return;
  }
  for (const pattern of patterns) {
    if (!content.includes(pattern)) {
      failures.push(`[required] ${relativePath} must include "${pattern}" (${reason})`);
    }
  }
  return content;
}

const failures = [];

const forbiddenRules = [
  {
    file: 'server/src/modules/ai/ai.service.ts',
    patterns: ['generateFallbackAiReply', 'streamFallbackAiReply'],
    reason: 'chat/chat-stream runtime must not call TS fallback adapter',
  },
  {
    file: 'server/src/modules/ai/ai.routes.shared.ts',
    patterns: ['ts-fallback-captured', "'ts-fallback'"],
    reason: 'chat memory capture contract must stay python-first',
  },
  {
    file: 'server/src/modules/ai/ai.routes.chat.ts',
    patterns: ['runtimeFallbackReason'],
    reason: 'chat routes should not expose runtime fallback fields',
  },
];

for (const rule of forbiddenRules) {
  if (!exists(rule.file)) {
    failures.push(`[required] ${rule.file} is missing (${rule.reason})`);
    continue;
  }
  const content = read(rule.file);
  for (const pattern of rule.patterns) {
    if (content.includes(pattern)) {
      failures.push(`[forbidden] ${rule.file} includes "${pattern}" (${rule.reason})`);
    }
  }
}

const runtimeFacadePath = 'server/src/modules/ai/ai.runtime-facade.ts';
if (exists(runtimeFacadePath)) {
  const runtimeFacade = read(runtimeFacadePath);
  if (!runtimeFacade.includes('PYTHON_RUNTIME_REQUIRED')) {
    failures.push('[required] ai.runtime-facade.ts must throw PYTHON_RUNTIME_REQUIRED when python runtime is disabled');
  }
  if (runtimeFacade.includes('ts-fallback')) {
    failures.push('[forbidden] ai.runtime-facade.ts must not contain ts-fallback runtime branch');
  }
} else {
  failures.push(`[required] ${runtimeFacadePath} is missing (python runtime facade must exist)`);
}

const legacyRuntimePath = path.join(root, 'server', 'src', 'modules', 'ai', 'ai.legacy-runtime.ts');
if (fs.existsSync(legacyRuntimePath)) {
  failures.push('[forbidden] server/src/modules/ai/ai.legacy-runtime.ts must be deleted after python-first cutover');
}
const fallbackAdapterPath = path.join(root, 'server', 'src', 'modules', 'ai', 'ai.fallback-adapter.ts');
if (fs.existsSync(fallbackAdapterPath)) {
  failures.push('[forbidden] server/src/modules/ai/ai.fallback-adapter.ts must be deleted after python-only runtime cutover');
}

const aiModuleDir = path.join(root, 'server', 'src', 'modules', 'ai');
if (!fs.existsSync(aiModuleDir)) {
  failures.push('[required] server/src/modules/ai directory is missing (ai module must exist)');
} else {
  for (const entry of fs.readdirSync(aiModuleDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) {
      continue;
    }
    const relativePath = path.join('server', 'src', 'modules', 'ai', entry.name);
    const content = read(relativePath);
    if (content.includes("from './ai.legacy-runtime'") || content.includes('from "./ai.legacy-runtime"')) {
      failures.push(`[forbidden] ${relativePath} imports ai.legacy-runtime (legacy runtime is deleted)`);
    }
    if (content.includes("from './ai.fallback-adapter'") || content.includes('from "./ai.fallback-adapter"')) {
      failures.push(`[forbidden] ${relativePath} imports ai.fallback-adapter (python-only runtime no longer exposes fallback adapter)`);
    }
  }
}

requireContains(
  'python-agent/app/common.py',
  [
    'AI_LAYERED_AGENT_ENABLED',
    'AI_LAYERED_MAX_EXECUTE_ROUNDS',
    'AI_LAYERED_CONTEXT_CHAR_BUDGET',
    'AI_LAYERED_WEB_FALLBACK_MAX_ROUNDS',
    'parse_bool(os.getenv("AI_LAYERED_AGENT_ENABLED"), True)',
    'parse_int(os.getenv("AI_LAYERED_MAX_EXECUTE_ROUNDS"), 2)',
    'parse_int(os.getenv("AI_LAYERED_CONTEXT_CHAR_BUDGET"), 12000)',
    'parse_int(os.getenv("AI_LAYERED_WEB_FALLBACK_MAX_ROUNDS"), 1)',
  ],
  'layered agent config must be declared in AgentConfig with stable defaults'
);

requireContains(
  'python-agent/app/planner_executor_sm.py',
  ['PlannerState', 'PLAN', 'EXECUTE', 'ANSWER'],
  'planner/executor state machine must exist for layered agent routing'
);

const orchestration = requireFile(
  'python-agent/app/orchestration.py',
  'layered agent orchestration must be present'
);
if (orchestration !== null) {
  if (!orchestration.includes('ai_layered_agent_enabled')) {
    failures.push(
      '[required] python-agent/app/orchestration.py must branch on ai_layered_agent_enabled'
    );
  }
  if (!orchestration.includes('run_planner_executor')) {
    failures.push(
      '[required] python-agent/app/orchestration.py must call run_planner_executor in the layered path'
    );
  }
  const orchestrationLines = orchestration.split(/\r?\n/);
  const layeredLineIndex = orchestrationLines.findIndex((line) =>
    line.includes('ai_layered_agent_enabled')
  );
  if (layeredLineIndex >= 0) {
    const branchIndentMatch = orchestrationLines[layeredLineIndex].match(/^(\s*)/);
    const branchIndent = branchIndentMatch ? branchIndentMatch[1].length : 0;
    const layeredBranchLines = [];
    for (let i = layeredLineIndex + 1; i < orchestrationLines.length; i += 1) {
      const line = orchestrationLines[i];
      if (!line.trim()) {
        layeredBranchLines.push(line);
        continue;
      }
      const indentMatch = line.match(/^(\s*)/);
      const indent = indentMatch ? indentMatch[1].length : 0;
      if (indent <= branchIndent) {
        break;
      }
      layeredBranchLines.push(line);
    }
    if (layeredBranchLines.join('\n').includes('execute_tool')) {
      failures.push(
        '[forbidden] python-agent/app/orchestration.py layered branch must not call execute_tool directly'
      );
    }
  }
}

if (failures.length > 0) {
  console.error('[guard:ai-python-first] failed');
  for (const failure of failures) {
    console.error(` - ${failure}`);
  }
  process.exit(1);
}

console.log('[guard:ai-python-first] passed');
