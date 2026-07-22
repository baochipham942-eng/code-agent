#!/usr/bin/env node
// ============================================================================
// Role Pack 收录流水线：校验草稿 → 输出可签名上架的 RolePackEntry。
//
// 用法：
//   node scripts/security/role-pack-pin.mjs --draft role-pack-draft.json \
//     --skill-registry skill-registry.json --out role-pack-entry.json
//
// 草稿格式：{ roleId, agentMd, visual, skills: ['registry-name'], packVersion,
//   publisher, reviewedAt, description?, displayName?, minAppVersion?, tags?, risk? }
// ============================================================================

import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..', '..');
const DEFAULT_SKILL_REGISTRY_URL = 'https://agentneo.vercel.app/api/v1/skill-registry';

function parseArgs(argv) {
  const args = { draft: null, skillRegistry: null, out: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => { index += 1; return argv[index] ?? ''; };
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--draft') args.draft = next();
    else if (arg === '--skill-registry') args.skillRegistry = next();
    else if (arg === '--out') args.out = next();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  return 'Usage: node scripts/security/role-pack-pin.mjs --draft <draft.json> [--skill-registry <payload.json>] --out <entry.json>';
}

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read ${label} ${file}: ${error.message}`);
  }
}

function registryEntries(value) {
  const payload = value && typeof value === 'object' && value.payload && typeof value.payload === 'object'
    ? value.payload
    : value;
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.entries)) {
    throw new Error('skill registry payload must contain an entries array');
  }
  return payload.entries;
}

async function loadSkillRegistry(file) {
  if (file) return registryEntries(readJson(resolve(file), 'skill registry'));
  const response = await fetch(DEFAULT_SKILL_REGISTRY_URL);
  if (!response.ok) throw new Error(`Unable to fetch default skill registry: HTTP ${response.status}`);
  return registryEntries(await response.json());
}

async function loadRoleRules() {
  const tempDir = mkdtempSync(resolve(tmpdir(), 'role-pack-pin-'));
  const outfile = resolve(tempDir, 'role-rules.mjs');
  try {
    await build({
      stdin: {
        contents: [
          "export { validateBuiltinRolePack, BUILTIN_ROLES } from './src/host/services/roleAssets/builtinRoles.ts';",
          "export { BUILTIN_SKILLS } from './src/host/services/skills/builtinSkillsData.ts';",
          "export { SKILL_CATEGORIES } from './src/shared/constants/skillCatalog.ts';",
        ].join('\n'),
        resolveDir: REPO_ROOT,
        loader: 'ts',
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile,
      external: ['electron', 'better-sqlite3', 'node-pty', 'keytar', '@anthropic-ai/claude-agent-sdk'],
    });
    return await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  } finally {
    // ESM 已在 import 时完成求值；删除临时 bridge 不影响已取得的导出。
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateDraftShape(draft, categoryIds) {
  const problems = [];
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return ['draft must be a JSON object'];
  if (!nonEmptyString(draft.roleId)) problems.push('roleId must be non-empty');
  if (!nonEmptyString(draft.agentMd)) problems.push('agentMd must be non-empty');
  if (!nonEmptyString(draft.packVersion)) problems.push('packVersion must be non-empty');
  if (!Array.isArray(draft.skills)) problems.push('skills must be an array of registry names');
  if (!draft.visual || typeof draft.visual !== 'object' || Array.isArray(draft.visual)) {
    problems.push('visual must be an object');
  } else {
    for (const field of ['icon', 'category', 'displayName', 'profession', 'tags', 'quickPrompts']) {
      if (!(field in draft.visual)) problems.push(`visual.${field} is required`);
    }
    for (const field of ['icon', 'displayName', 'profession']) {
      if (field in draft.visual && !nonEmptyString(draft.visual[field])) {
        problems.push(`visual.${field} must be a non-empty string`);
      }
    }
    for (const field of ['tags', 'quickPrompts']) {
      if (field in draft.visual && (!Array.isArray(draft.visual[field])
        || draft.visual[field].some((item) => !nonEmptyString(item)))) {
        problems.push(`visual.${field} must be an array of non-empty strings`);
      }
    }
    if ('category' in draft.visual && (!nonEmptyString(draft.visual.category)
      || !categoryIds.has(draft.visual.category))) {
      problems.push(`visual.category "${draft.visual.category}" is not a valid SkillCategory`);
    }
    if (Array.isArray(draft.visual.tags) && draft.visual.tags.length === 0) problems.push('visual.tags must not be empty');
    if (Array.isArray(draft.visual.quickPrompts) && draft.visual.quickPrompts.length === 0) problems.push('visual.quickPrompts must not be empty');
  }
  if (Array.isArray(draft.skills) && draft.skills.some((name) => !nonEmptyString(name))) {
    problems.push('skills must contain only non-empty registry names');
  }
  return problems;
}

function toEntry(draft) {
  return {
    roleId: draft.roleId,
    ...(nonEmptyString(draft.displayName) ? { displayName: draft.displayName } : {}),
    ...(nonEmptyString(draft.description) ? { description: draft.description } : {}),
    agentMd: draft.agentMd,
    visual: draft.visual,
    skills: draft.skills.map((registryName) => ({ registryName })),
    packVersion: draft.packVersion,
    ...(nonEmptyString(draft.minAppVersion) ? { minAppVersion: draft.minAppVersion } : {}),
    publisher: nonEmptyString(draft.publisher) ? draft.publisher : 'Agent Neo',
    reviewedAt: nonEmptyString(draft.reviewedAt) ? draft.reviewedAt : new Date().toISOString().slice(0, 10),
    ...(Array.isArray(draft.tags) ? { tags: draft.tags } : {}),
    ...(draft.risk ? { risk: draft.risk } : {}),
  };
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) { console.log(usage()); return; }
  if (!args.draft || !args.out) {
    console.error(usage());
    process.exit(2);
  }

  const draft = readJson(resolve(args.draft), 'role pack draft');
  const rules = await loadRoleRules();
  const problems = validateDraftShape(draft, new Set(rules.SKILL_CATEGORIES.map((category) => category.id)));
  if (problems.length > 0) {
    for (const problem of problems) console.error(`[validate] FAIL ${problem}`);
    process.exit(1);
  }

  const registryNames = new Set((await loadSkillRegistry(args.skillRegistry))
    .map((entry) => entry?.name).filter(nonEmptyString));
  const registryRefs = draft.skills;
  const missingRegistryRefs = [...new Set(registryRefs.filter((name) => !registryNames.has(name)))];
  if (missingRegistryRefs.length > 0) {
    problems.push(`registry skill(s) not found: ${missingRegistryRefs.join(', ')}`);
  }

  if (rules.BUILTIN_ROLES.some((role) => role.id === draft.roleId)) {
    problems.push(`roleId "${draft.roleId}" conflicts with a builtin role`);
  }

  const entry = toEntry(draft);
  const knownSkillNames = new Set([
    ...rules.BUILTIN_SKILLS.map((skill) => skill.name),
    ...registryRefs.filter((name) => registryNames.has(name)),
  ]);
  for (const issue of rules.validateBuiltinRolePack(
    { id: entry.roleId, agentMd: entry.agentMd, visual: entry.visual },
    knownSkillNames,
  )) {
    problems.push(issue.issue);
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`[validate] FAIL ${problem}`);
    process.exit(1);
  }

  writeFileSync(resolve(args.out), `${JSON.stringify(entry, null, 2)}\n`);
  console.error(`[role-pack-pin] wrote ${resolve(args.out)}`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`[role-pack-pin] ${error.message}`);
  process.exit(1);
});
