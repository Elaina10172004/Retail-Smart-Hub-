import fs from 'node:fs';
import path from 'node:path';

type PromptCatalog = {
  server?: {
    system_prompt_lines?: string[];
  };
};

function looksCorrupted(lines: string[]) {
  const merged = lines.join('\n');
  if (!merged.trim()) {
    return true;
  }

  const questionCount = (merged.match(/\?/g) || []).length;
  if (questionCount >= 6 && questionCount / Math.max(1, merged.length) > 0.08) {
    return true;
  }

  const mojibakeMarkers = ['浣', '鍙', '銆', '闃', '缁', '锛', '馃', '�'];
  const mojibakeCount = mojibakeMarkers.reduce((sum, marker) => sum + merged.split(marker).length - 1, 0);
  return mojibakeCount >= 4;
}

function loadPromptCatalog(): PromptCatalog {
  const candidates = [
    path.resolve(process.cwd(), 'AI_PROMPTS.json'),
    path.resolve(process.cwd(), '..', 'AI_PROMPTS.json'),
    path.resolve(__dirname, '../../../../../AI_PROMPTS.json'),
  ];

  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) {
        continue;
      }
      const raw = fs.readFileSync(candidate, 'utf8');
      const parsed = JSON.parse(raw) as PromptCatalog;
      return parsed || {};
    } catch {
      continue;
    }
  }

  return {};
}

const PROMPT_CATALOG = loadPromptCatalog();

export function getServerPromptLines(key: 'system_prompt_lines', fallback: string[]) {
  const value = PROMPT_CATALOG.server?.[key];
  if (Array.isArray(value) && value.length > 0) {
    const normalized = value.map((item) => String(item)).filter((item) => item.trim().length > 0);
    if (normalized.length > 0 && !looksCorrupted(normalized)) {
      return normalized;
    }
  }
  return fallback;
}
