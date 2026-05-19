/**
 * Skill catalog and matching service shared by Node internal bridge.
 *
 * Runtime behavior:
 * - Python runtime: python-agent calls /api/internal/agent/skills/match, then injects
 *   returned context into model orchestration.
 *
 * This file remains a single source for skill loading / gating / matching for the bridge path.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type SkillSource = 'workspace' | 'global' | 'bundled';

interface SkillCatalogRoot {
  source: SkillSource;
  rootPath: string;
  priority: number;
}

interface ParsedFrontmatter {
  name?: string;
  description?: string;
  triggers?: string[];
  tools?: string[];
  requires_permissions?: string[];
  requires_env?: string[];
  requires_bins?: string[];
  enabled?: string;
}

interface ParsedBodyMetadata {
  triggers: string[];
  tools: string[];
  requiresPermissions: string[];
  requiresEnv: string[];
  requiresBins: string[];
  enabled?: boolean;
}

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  triggers: string[];
  tools: string[];
  requiresPermissions: string[];
  requiresEnv: string[];
  requiresBins: string[];
  source: SkillSource;
  rootPath: string;
  skillPath: string;
  skillFile: string;
  body: string;
  referenceIndex: string;
  enabled: boolean;
}

export interface SkillMatch {
  id: string;
  name: string;
  description: string;
  source: SkillSource;
  score: number;
  reason: string;
  snippet: string;
  referenceIndex: string;
  tools: string[];
}

export interface SkillMatchResult {
  matchedSkills: SkillMatch[];
  availableSkillCount: number;
  disabledSkillCount: number;
}

interface SkillCache {
  signature: string;
  skills: SkillDefinition[];
}

let cache: SkillCache = {
  signature: '',
  skills: [],
};

const CORE_SKILL_ID = 'retailflow-analysis';

function getBundledSkillsPath() {
  const candidates = [
    path.resolve(process.cwd(), 'server', 'src', 'modules', 'ai', 'skills-builtin'),
    path.resolve(process.cwd(), 'dist-server', 'modules', 'ai', 'skills-builtin'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[candidates.length - 1];
}

function getSkillRoots(): SkillCatalogRoot[] {
  const workspaceSkills = path.resolve(process.cwd(), '..', 'skills');
  const globalSkills = path.resolve(os.homedir(), '.retail-smart-hub', 'skills');
  const bundledSkills = getBundledSkillsPath();

  return [
    { source: 'workspace', rootPath: workspaceSkills, priority: 3 },
    { source: 'global', rootPath: globalSkills, priority: 2 },
    { source: 'bundled', rootPath: bundledSkills, priority: 1 },
  ];
}

function normalizeListValue(value: string) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeMetadataLabel(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function splitMetadataValues(value: string) {
  return value
    .split(/[,\uFF0C\u3001]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseFrontmatter(raw: string) {
  const trimmed = raw.replace(/^\uFEFF/, '');
  if (!trimmed.startsWith('---\n') && !trimmed.startsWith('---\r\n')) {
    return {
      frontmatter: {} as ParsedFrontmatter,
      body: trimmed,
    };
  }

  const closeMarker = trimmed.indexOf('\n---', 4);
  if (closeMarker <= 0) {
    return {
      frontmatter: {} as ParsedFrontmatter,
      body: trimmed,
    };
  }

  const fmRaw = trimmed.slice(4, closeMarker).replace(/\r/g, '');
  const body = trimmed.slice(closeMarker + 4).trim();
  const lines = fmRaw.split('\n');
  const frontmatter: ParsedFrontmatter = {};
  let currentListKey = '';

  for (const line of lines) {
    const itemLine = line.trim();
    if (!itemLine) {
      continue;
    }

    if (itemLine.startsWith('- ') && currentListKey) {
      const item = itemLine.slice(2).trim();
      if (!item) {
        continue;
      }
      const list = (frontmatter[currentListKey as keyof ParsedFrontmatter] as string[] | undefined) ?? [];
      list.push(item);
      (frontmatter[currentListKey as keyof ParsedFrontmatter] as string[] | undefined) = list;
      continue;
    }

    const delimiter = itemLine.indexOf(':');
    if (delimiter <= 0) {
      continue;
    }

    const key = itemLine.slice(0, delimiter).trim().toLowerCase();
    const value = itemLine.slice(delimiter + 1).trim();
    currentListKey = '';

    if (!value) {
      currentListKey = key;
      (frontmatter[key as keyof ParsedFrontmatter] as string[] | undefined) =
        (frontmatter[key as keyof ParsedFrontmatter] as string[] | undefined) ?? [];
      continue;
    }

    if (['triggers', 'tools', 'requires_permissions', 'requires_env', 'requires_bins'].includes(key)) {
      (frontmatter[key as keyof ParsedFrontmatter] as string[] | undefined) = normalizeListValue(value);
      continue;
    }

    (frontmatter[key as keyof ParsedFrontmatter] as string | undefined) = value;
  }

  return { frontmatter, body };
}

function parseBodyMetadata(rawBody: string) {
  const lines = rawBody.replace(/\r/g, '').split('\n');
  const metadata: ParsedBodyMetadata = {
    triggers: [],
    tools: [],
    requiresPermissions: [],
    requiresEnv: [],
    requiresBins: [],
  };
  const strippedBody: string[] = [];
  let inMetadataSection = false;
  let metadataHeadingLevel = 0;

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (headingMatch) {
      const headingLevel = headingMatch[1].length;
      const headingLabel = normalizeMetadataLabel(headingMatch[2]);
      const isMetadataHeading =
        headingLevel === 2 &&
        ['runtime metadata', 'activation hints', '运行时元数据', '触发提示'].includes(headingLabel);

      if (isMetadataHeading) {
        inMetadataSection = true;
        metadataHeadingLevel = headingLevel;
        continue;
      }

      if (inMetadataSection && headingLevel <= metadataHeadingLevel) {
        inMetadataSection = false;
        metadataHeadingLevel = 0;
      }
    }

    if (inMetadataSection) {
      const itemMatch = line.match(/^\s*[-*]\s*([^:：]+)\s*[:：]\s*(.*?)\s*$/);
      if (!itemMatch) {
        continue;
      }

      const label = normalizeMetadataLabel(itemMatch[1]);
      const value = itemMatch[2];

      if (['triggers', 'trigger', '触发词', '触发器'].includes(label)) {
        metadata.triggers.push(...splitMetadataValues(value));
        continue;
      }
      if (['recommended tools', 'tools', '推荐工具', '工具'].includes(label)) {
        metadata.tools.push(...splitMetadataValues(value));
        continue;
      }
      if (['requires permissions', 'required permissions', '需要权限', '权限'].includes(label)) {
        metadata.requiresPermissions.push(...splitMetadataValues(value));
        continue;
      }
      if (['requires env', 'required env', '环境变量', '需要环境变量'].includes(label)) {
        metadata.requiresEnv.push(...splitMetadataValues(value));
        continue;
      }
      if (['requires bins', 'required bins', '依赖命令', '需要命令'].includes(label)) {
        metadata.requiresBins.push(...splitMetadataValues(value));
        continue;
      }
      if (['enabled', '启用'].includes(label)) {
        metadata.enabled = resolveBoolean(value, true);
      }
      continue;
    }

    strippedBody.push(line);
  }

  return {
    metadata,
    body: strippedBody.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
  };
}

function resolveBoolean(value: string | undefined, fallback: boolean) {
  if (value == null || value === '') {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['false', '0', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function detectSkillSignature() {
  const roots = getSkillRoots();
  const signatures: string[] = [];

  for (const root of roots) {
    if (!fs.existsSync(root.rootPath)) {
      signatures.push(`${root.source}:missing`);
      continue;
    }

    const subdirs = fs
      .readdirSync(root.rootPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));

    if (subdirs.length === 0) {
      signatures.push(`${root.source}:empty`);
      continue;
    }

    for (const subdir of subdirs) {
      const skillFile = path.join(root.rootPath, subdir, 'SKILL.md');
      if (!fs.existsSync(skillFile)) {
        signatures.push(`${root.source}:${subdir}:no-skill-file`);
        continue;
      }
      const stats = fs.statSync(skillFile);
      signatures.push(`${root.source}:${subdir}:${stats.mtimeMs}:${stats.size}`);
      const referenceIndex = path.join(root.rootPath, subdir, 'references', 'index.md');
      if (fs.existsSync(referenceIndex)) {
        const referenceStats = fs.statSync(referenceIndex);
        signatures.push(`${root.source}:${subdir}:ref:${referenceStats.mtimeMs}:${referenceStats.size}`);
      }
    }
  }

  return signatures.join('|');
}

function findExecutable(bin: string) {
  const pathEnv = process.env.PATH || '';
  const extensions =
    process.platform === 'win32'
      ? ['.exe', '.cmd', '.bat', '.ps1', '']
      : [''];

  for (const folder of pathEnv.split(path.delimiter)) {
    const cleanFolder = folder.trim();
    if (!cleanFolder) {
      continue;
    }
    for (const ext of extensions) {
      const candidate = path.join(cleanFolder, `${bin}${ext}`);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return '';
}

function readReferenceIndex(skillPath: string) {
  const candidate = path.join(skillPath, 'references', 'index.md');
  if (!fs.existsSync(candidate)) {
    return '';
  }
  try {
    return fs.readFileSync(candidate, 'utf8').trim();
  } catch {
    return '';
  }
}

function loadSkills() {
  const signature = detectSkillSignature();
  if (signature === cache.signature) {
    return cache.skills;
  }

  const roots = getSkillRoots().sort((left, right) => right.priority - left.priority);
  const byId = new Map<string, SkillDefinition>();

  for (const root of roots) {
    if (!fs.existsSync(root.rootPath)) {
      continue;
    }

    const subdirs = fs.readdirSync(root.rootPath, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    for (const dir of subdirs) {
      const skillPath = path.join(root.rootPath, dir.name);
      const skillFile = path.join(skillPath, 'SKILL.md');
      if (!fs.existsSync(skillFile)) {
        continue;
      }

      const raw = fs.readFileSync(skillFile, 'utf8');
      const parsed = parseFrontmatter(raw);
      const bodyParsed = parseBodyMetadata(parsed.body);
      const skillId = dir.name.toLowerCase();
      const description =
        parsed.frontmatter.description?.trim() || bodyParsed.body.split('\n').find(Boolean)?.trim() || 'No description';
      const triggers =
        bodyParsed.metadata.triggers.length > 0
          ? bodyParsed.metadata.triggers
          : parsed.frontmatter.triggers && parsed.frontmatter.triggers.length > 0
            ? parsed.frontmatter.triggers
            : [skillId];
      const skill: SkillDefinition = {
        id: skillId,
        name: parsed.frontmatter.name?.trim() || dir.name,
        description,
        triggers: triggers.map((item) => item.toLowerCase()),
        tools:
          bodyParsed.metadata.tools.length > 0
            ? bodyParsed.metadata.tools
            : (parsed.frontmatter.tools ?? []).map((item) => item.trim()).filter(Boolean),
        requiresPermissions:
          bodyParsed.metadata.requiresPermissions.length > 0
            ? bodyParsed.metadata.requiresPermissions
            : (parsed.frontmatter.requires_permissions ?? []),
        requiresEnv:
          bodyParsed.metadata.requiresEnv.length > 0
            ? bodyParsed.metadata.requiresEnv
            : (parsed.frontmatter.requires_env ?? []),
        requiresBins:
          bodyParsed.metadata.requiresBins.length > 0
            ? bodyParsed.metadata.requiresBins
            : (parsed.frontmatter.requires_bins ?? []),
        source: root.source,
        rootPath: root.rootPath,
        skillPath,
        skillFile,
        body: bodyParsed.body.trim(),
        referenceIndex: readReferenceIndex(skillPath),
        enabled: bodyParsed.metadata.enabled ?? resolveBoolean(parsed.frontmatter.enabled, true),
      };

      if (!byId.has(skill.id)) {
        byId.set(skill.id, skill);
      }
    }
  }

  const skills = Array.from(byId.values()).sort((left, right) => left.name.localeCompare(right.name));
  cache = {
    signature,
    skills,
  };
  return skills;
}

function checkSkillEnabled(skill: SkillDefinition, permissions: string[]) {
  if (!skill.enabled) {
    return { enabled: false, reason: 'skill disabled' };
  }

  for (const envName of skill.requiresEnv) {
    if (!process.env[envName]) {
      return { enabled: false, reason: `missing env: ${envName}` };
    }
  }

  for (const binName of skill.requiresBins) {
    if (!findExecutable(binName)) {
      return { enabled: false, reason: `missing bin: ${binName}` };
    }
  }

  if (skill.requiresPermissions.length > 0 && !skill.requiresPermissions.some((permission) => permissions.includes(permission))) {
    return { enabled: false, reason: 'permission not satisfied' };
  }

  return { enabled: true, reason: 'ok' };
}

function normalizePrompt(prompt: string) {
  return prompt.trim().toLowerCase();
}

function scoreSkillMatch(skill: SkillDefinition, normalizedPrompt: string) {
  let score = 0;
  const matchedTriggers: string[] = [];

  for (const trigger of skill.triggers) {
    if (normalizedPrompt.includes(trigger)) {
      score += Math.max(1, trigger.length);
      matchedTriggers.push(trigger);
    }
  }

  if (normalizedPrompt.includes(skill.name.toLowerCase())) {
    score += 3;
    matchedTriggers.push(skill.name.toLowerCase());
  }

  return {
    score,
    reason: matchedTriggers.length > 0 ? `matched: ${Array.from(new Set(matchedTriggers)).join(', ')}` : '',
  };
}

export function matchSkillsForPrompt(input: { prompt: string; permissions: string[]; limit?: number }): SkillMatchResult {
  const skills = loadSkills();
  const normalizedPrompt = normalizePrompt(input.prompt);
  const limit = Math.max(1, Math.min(8, input.limit ?? 4));
  let disabledSkillCount = 0;
  const matches: SkillMatch[] = [];
  let coreSkill: SkillDefinition | null = null;

  for (const skill of skills) {
    const gating = checkSkillEnabled(skill, input.permissions);
    if (!gating.enabled) {
      disabledSkillCount += 1;
      continue;
    }

    if (skill.id === CORE_SKILL_ID) {
      coreSkill = skill;
    }

    const matched = scoreSkillMatch(skill, normalizedPrompt);
    if (matched.score <= 0) {
      continue;
    }

    matches.push({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      source: skill.source,
      score: matched.score,
      reason: matched.reason,
      snippet: skill.body.slice(0, 1200),
      referenceIndex: skill.referenceIndex.slice(0, 1000),
      tools: skill.tools,
    });
  }

  matches.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.name.localeCompare(right.name);
  });

  if (matches.length === 0 && coreSkill) {
    matches.push({
      id: coreSkill.id,
      name: coreSkill.name,
      description: coreSkill.description,
      source: coreSkill.source,
      score: Math.max(1, normalizedPrompt.length > 0 ? 1 : 0),
      reason: 'fallback core skill',
      snippet: coreSkill.body.slice(0, 1200),
      referenceIndex: coreSkill.referenceIndex.slice(0, 1000),
      tools: coreSkill.tools,
    });
  }

  return {
    matchedSkills: matches.slice(0, limit),
    availableSkillCount: skills.length - disabledSkillCount,
    disabledSkillCount,
  };
}

export function buildSkillContext(matches: SkillMatch[]) {
  if (matches.length === 0) {
    return 'No active skill context.';
  }

  return matches
    .map((skill, index) => {
      return [
        `[Skill ${index + 1}] ${skill.name} (${skill.source})`,
        `Description: ${skill.description}`,
        `Reason: ${skill.reason}`,
        `Recommended tools: ${skill.tools.length > 0 ? skill.tools.join(', ') : 'auto'}`,
        `Instruction: ${skill.snippet || '-'}`,
        ...(skill.referenceIndex
          ? [`Reference index: ${skill.referenceIndex}`]
          : []),
      ].join('\n');
    })
    .join('\n\n');
}

export function getSkillStats() {
  const skills = loadSkills();
  const bySource = skills.reduce(
    (acc, item) => {
      acc[item.source] += 1;
      return acc;
    },
    {
      workspace: 0,
      global: 0,
      bundled: 0,
    } as Record<SkillSource, number>,
  );

  return {
    total: skills.length,
    bySource,
    roots: getSkillRoots().map((item) => ({
      source: item.source,
      rootPath: item.rootPath,
      exists: fs.existsSync(item.rootPath),
    })),
    skills: skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      source: skill.source,
      triggers: skill.triggers,
      enabled: skill.enabled,
    })),
  };
}
