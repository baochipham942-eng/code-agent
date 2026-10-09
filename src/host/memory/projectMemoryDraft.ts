// ============================================================================
// Project Memory Draft — /init-memory 的确定性扫描器（N-INIT-PROJECT-MEMORY-CMD）
//
// 只读白名单清单文件（package.json / pyproject.toml / go.mod / Cargo.toml /
// Makefile / README*）与顶层目录名，产出固定四个主题的 project 记忆草稿：
// 技术栈 / 目录结构 / 常用命令 / README 一句话定位。只陈述文件里确证的事实，
// 来源缺失的主题直接跳过；不读 .env，不跟随符号链接，不走出 projectDir。
//
// 每条草稿 id = hash(projectDir + topic)，status 恒为 'candidate'——已有同键条目
// （任何 status）只跳过不覆盖，重跑幂等。写入复用 memoryEntryRuntime 的
// writeEntryToLightMemory + rebuildMemoryMirrorFromLightFiles，与 harness importer
// 同一条落盘链路（memoryEntryFromRaw 风格构造，但不伪装 harness 来源）。
// ============================================================================

import * as fs from 'fs/promises';
import path from 'node:path';
import type {
  MemoryEntry,
  MemoryEntryEvidence,
  ProjectMemoryDraftResult,
  ProjectMemoryDraftTopic,
} from '../../shared/contract/memory';
import { PROJECT_MEMORY_DRAFT } from '../../shared/constants';
import { contentHash } from './importers/markdown';
import {
  listUnifiedMemoryEntries,
  rebuildMemoryMirrorFromLightFiles,
  writeEntryToLightMemory,
  type MemoryEntryDatabase,
} from './memoryEntryRuntime';

export interface ProjectMemoryDraftOptions {
  projectDir: string;
  now?: number;
}

/** 扫描允许读取的清单文件名（README* 单独按前缀匹配，均限定 projectDir 顶层）。 */
const MANIFEST_FILE_NAMES = ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'Makefile'] as const;
const README_PREFIX = 'readme';
/** .env 及其变体绝不在读取范围内——白名单本就不含它，这里显式拒绝兜底。 */
const FORBIDDEN_NAME_PATTERN = /^\.env/;
/** 目录布局里跳过的机械目录：点开头目录与 node_modules 是工具产物，不是项目分层。 */
const LAYOUT_SKIP_DIR_NAMES = new Set(['node_modules']);

const TOPIC_TITLES: Record<ProjectMemoryDraftTopic, string> = {
  'tech-stack': '技术栈',
  'directory-layout': '目录结构',
  'common-commands': '常用命令',
  'readme-purpose': '项目定位',
};

interface DraftFacts {
  topic: ProjectMemoryDraftTopic;
  summary: string;
  content: string;
  sources: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function clampList(items: string[]): { text: string; truncated: boolean } {
  const capped = items.slice(0, PROJECT_MEMORY_DRAFT.LIST_MAX_ITEMS);
  return {
    text: capped.join('、'),
    truncated: items.length > capped.length,
  };
}

/** 白名单文件读取：lstat 只认普通文件（符号链接一律不跟），.env 变体显式拒绝，按字节上限截断。 */
async function readCappedManifest(filePath: string): Promise<string | null> {
  let handle: fs.FileHandle;
  try {
    if (FORBIDDEN_NAME_PATTERN.test(path.basename(filePath))) return null;
    const stat = await fs.lstat(filePath);
    if (!stat.isFile()) return null;
    handle = await fs.open(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(PROJECT_MEMORY_DRAFT.FILE_MAX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/** 找到 projectDir 顶层第一个匹配 README* 的普通文件名（点开头/.env 变体不参与）。 */
async function findReadmeName(projectDir: string): Promise<string | null> {
  let names: string[];
  try {
    names = await fs.readdir(projectDir);
  } catch {
    return null;
  }
  const matched = names
    .filter((name) => name.toLowerCase().startsWith(README_PREFIX))
    .filter((name) => !name.startsWith('.') && !FORBIDDEN_NAME_PATTERN.test(name))
    .sort();
  return matched[0] ?? null;
}

function dependencyVersionMap(value: unknown): Array<{ name: string; version: string }> {
  if (!isRecord(value)) return [];
  return Object.entries(value)
    .filter((entry): entry is [string, unknown] => typeof entry[1] === 'string')
    .map(([name, version]) => ({ name, version: version as string }));
}

function packageJsonFacts(raw: string): { lines: string[] } | null {
  let pkg: unknown;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(pkg)) return null;
  const lines: string[] = [];
  if (typeof pkg.name === 'string') {
    lines.push(`Node.js 项目：${pkg.name}${typeof pkg.version === 'string' ? `@${pkg.version}` : ''}`);
  } else {
    lines.push('Node.js 项目（package.json 未声明 name）');
  }
  const engines = isRecord(pkg.engines) ? pkg.engines.node : undefined;
  if (typeof engines === 'string') lines.push(`Node 引擎要求：${engines}`);
  for (const [label, field] of [['运行依赖', 'dependencies'], ['开发依赖', 'devDependencies']] as const) {
    const deps = dependencyVersionMap(pkg[field]);
    if (deps.length === 0) continue;
    const { text, truncated } = clampList(deps.map((dep) => `${dep.name}@${dep.version}`));
    lines.push(`${label}（${deps.length} 项）：${text}${truncated ? ' 等' : ''}`);
  }
  return { lines };
}

/** TOML 逐行小解析：跟踪当前 [section]，取 key = "value" 与数组项。 */
function parseTomlSections(raw: string): Map<string, Array<{ key: string; value: string | null; arrayItems: string[] }>> {
  const sections = new Map<string, Array<{ key: string; value: string | null; arrayItems: string[] }>>();
  let current = '';
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
    if (sectionMatch) {
      current = sectionMatch[1];
      continue;
    }
    const entryMatch = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (!entryMatch) continue;
    const rest = entryMatch[2].trim();
    const arrayMatch = /^[[(](.*)[\])]$/.exec(rest);
    const arrayItems = arrayMatch
      ? [...arrayMatch[1].matchAll(/"([^"]+)"/g)].map((item) => item[1])
      : [];
    const entries = sections.get(current) ?? [];
    entries.push({ key: entryMatch[1], value: arrayItems.length ? null : rest.replace(/^["']|["']$/g, '') || null, arrayItems });
    sections.set(current, entries);
  }
  return sections;
}

function pyprojectFacts(raw: string): { lines: string[] } | null {
  const sections = parseTomlSections(raw);
  const project = sections.get('project') ?? [];
  const poetry = sections.get('tool.poetry') ?? [];
  if (project.length === 0 && poetry.length === 0) return null;
  const lines: string[] = [];
  const name = project.find((e) => e.key === 'name')?.value
    ?? poetry.find((e) => e.key === 'name')?.value;
  lines.push(`Python 项目${name ? `：${name}` : ''}`);
  const declared = project.find((e) => e.key === 'dependencies')?.arrayItems ?? [];
  if (declared.length > 0) {
    const { text, truncated } = clampList(declared.map((item) => item.split(/[<>=!~;\s]/)[0] || item));
    lines.push(`依赖（${declared.length} 项）：${text}${truncated ? ' 等' : ''}`);
  } else {
    const poetryDeps = sections.get('tool.poetry.dependencies') ?? [];
    const names = poetryDeps.map((e) => e.key).filter((key) => key !== 'python');
    if (names.length > 0) {
      const { text, truncated } = clampList(names);
      lines.push(`依赖（${names.length} 项）：${text}${truncated ? ' 等' : ''}`);
    }
  }
  return { lines };
}

function cargoFacts(raw: string): { lines: string[] } | null {
  const sections = parseTomlSections(raw);
  const pkg = sections.get('package') ?? [];
  const deps = sections.get('dependencies') ?? [];
  if (pkg.length === 0 && deps.length === 0) return null;
  const name = pkg.find((e) => e.key === 'name')?.value;
  const version = pkg.find((e) => e.key === 'version')?.value;
  const lines = [`Rust 项目${name ? `：${name}${version ? `@${version}` : ''}` : ''}`];
  if (deps.length > 0) {
    const { text, truncated } = clampList(deps.map((e) => e.key));
    lines.push(`依赖（${deps.length} 项）：${text}${truncated ? ' 等' : ''}`);
  }
  return { lines };
}

function goModFacts(raw: string): { lines: string[] } | null {
  const modules: string[] = [];
  let modulePath: string | null = null;
  let inRequireBlock = false;
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    if (/^require\s*\($/.test(line)) { inRequireBlock = true; continue; }
    if (inRequireBlock && /^\)$/.test(line)) { inRequireBlock = false; continue; }
    const single = /^require\s+(\S+)\s+(\S+)/.exec(line);
    if (single && !inRequireBlock) {
      modules.push(`${single[1]}@${single[2]}`);
      continue;
    }
    const blockItem = inRequireBlock ? /^(\S+)\s+(\S+)$/.exec(line) : null;
    if (blockItem) modules.push(`${blockItem[1]}@${blockItem[2]}`);
    const moduleLine = /^module\s+(\S+)/.exec(line);
    if (moduleLine) modulePath = moduleLine[1];
  }
  if (modulePath === null && modules.length === 0) return null;
  const lines = [`Go 项目：module ${modulePath ?? '（未声明）'}`];
  if (modules.length > 0) {
    const { text, truncated } = clampList(modules);
    lines.push(`require（${modules.length} 项）：${text}${truncated ? ' 等' : ''}`);
  }
  return { lines };
}

function makefileTargets(raw: string): string[] {
  const targets: string[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    if (rawLine.startsWith('\t') || rawLine.startsWith(' ')) continue;
    const match = /^([A-Za-z0-9][A-Za-z0-9._%/-]*)\s*:(?!=)/.exec(rawLine);
    if (match) targets.push(match[1]);
  }
  return targets;
}

function readmePurposeLine(raw: string): string | null {
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^#{1,6}\s/.test(line)) continue; // 标题行（多为项目名），不是定位句
    if (line.startsWith('<') || line.startsWith('[!') || line.startsWith('![')) continue; // 徽章 / HTML / 图片
    if (/^\[[^\]]+\]:/.test(line)) continue; // 链接引用定义
    const normalized = line.replace(/\s+/g, ' ');
    if (normalized.length > PROJECT_MEMORY_DRAFT.README_PURPOSE_MAX_CHARS) {
      return `${normalized.slice(0, PROJECT_MEMORY_DRAFT.README_PURPOSE_MAX_CHARS - 3).trimEnd()}...`;
    }
    return normalized;
  }
  return null;
}

async function collectDraftFacts(projectDir: string): Promise<DraftFacts[]> {
  const manifests = new Map<string, string>();
  for (const name of MANIFEST_FILE_NAMES) {
    const raw = await readCappedManifest(path.join(projectDir, name));
    if (raw !== null) manifests.set(name, raw);
  }
  const readmeName = await findReadmeName(projectDir);
  const readmeRaw = readmeName ? await readCappedManifest(path.join(projectDir, readmeName)) : null;

  const drafts: DraftFacts[] = [];

  const stackLines: string[] = [];
  const stackSources: string[] = [];
  const manifestParsers: Array<[string, (raw: string) => { lines: string[] } | null]> = [
    ['package.json', packageJsonFacts],
    ['pyproject.toml', pyprojectFacts],
    ['go.mod', goModFacts],
    ['Cargo.toml', cargoFacts],
  ];
  for (const [name, parse] of manifestParsers) {
    const raw = manifests.get(name);
    if (raw === undefined) continue;
    const facts = parse(raw);
    if (!facts) continue;
    stackLines.push(...facts.lines);
    stackSources.push(name);
  }
  if (stackLines.length > 0) {
    drafts.push({
      topic: 'tech-stack',
      summary: `来自 ${stackSources.join('、')} 的确定性扫描`,
      content: stackLines.join('\n'),
      sources: stackSources,
    });
  }

  const commandLines: string[] = [];
  const commandSources: string[] = [];
  const packageRaw = manifests.get('package.json');
  if (packageRaw !== undefined) {
    let pkg: unknown;
    try {
      pkg = JSON.parse(packageRaw);
    } catch {
      pkg = null;
    }
    const scripts = isRecord(pkg) && isRecord(pkg.scripts) ? Object.entries(pkg.scripts) : [];
    for (const [script, command] of scripts.slice(0, PROJECT_MEMORY_DRAFT.LIST_MAX_ITEMS)) {
      if (typeof command === 'string') commandLines.push(`npm run ${script} — ${command}`);
    }
    if (scripts.length > 0) commandSources.push('package.json');
  }
  const makefileRaw = manifests.get('Makefile');
  if (makefileRaw !== undefined) {
    const targets = makefileTargets(makefileRaw).slice(0, PROJECT_MEMORY_DRAFT.LIST_MAX_ITEMS);
    for (const target of targets) commandLines.push(`make ${target}`);
    if (targets.length > 0) commandSources.push('Makefile');
  }
  if (commandLines.length > 0) {
    drafts.push({
      topic: 'common-commands',
      summary: `来自 ${commandSources.join('、')} 的脚本与目标`,
      content: commandLines.join('\n'),
      sources: commandSources,
    });
  }

  let dirNames: string[];
  try {
    const entries = await fs.readdir(projectDir, { withFileTypes: true });
    dirNames = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !LAYOUT_SKIP_DIR_NAMES.has(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    dirNames = []; // projectDir 不可读 → 当作无目录可列
  }
  if (dirNames.length > 0) {
    const shown = dirNames.slice(0, PROJECT_MEMORY_DRAFT.LAYOUT_MAX_DIRS);
    drafts.push({
      topic: 'directory-layout',
      summary: `顶层目录（共 ${dirNames.length} 个）`,
      content: `顶层目录（共 ${dirNames.length} 个）：${shown.join('、')}${dirNames.length > shown.length ? ' 等' : ''}`,
      sources: [],
    });
  }

  if (readmeName && readmeRaw !== null) {
    const purpose = readmePurposeLine(readmeRaw);
    if (purpose) {
      drafts.push({
        topic: 'readme-purpose',
        summary: 'README 首个正文段落',
        content: `README 定位：${purpose}`,
        sources: [readmeName],
      });
    }
  }

  return drafts;
}

function draftEntryId(projectDir: string, topic: ProjectMemoryDraftTopic): string {
  return `initmem_${contentHash(`${projectDir}\n${topic}`)}`;
}

function draftEntry(projectDir: string, facts: DraftFacts, now: number): MemoryEntry {
  const id = draftEntryId(projectDir, facts.topic);
  const hash = id.slice('initmem_'.length);
  const evidence: MemoryEntryEvidence[] = facts.sources.map((source) => ({
    filePath: source,
    source: 'init-memory',
  }));
  return {
    id,
    schemaVersion: 2,
    status: 'candidate',
    deprecatedBy: null,
    kind: 'project',
    scope: 'project',
    title: `${TOPIC_TITLES[facts.topic]}（init-memory 草稿）`,
    summary: facts.summary,
    content: facts.content,
    source: {
      kind: 'import',
      sourceOfTruth: 'light_file',
      filePath: `initmem-${hash}.md`,
      label: `init-memory: ${projectDir}`,
    },
    evidence,
    projectPath: projectDir,
    sessionId: null,
    confidence: 0.7,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 扫描 projectDir 并把项目记忆草稿写成 candidate。
 * 同键（id = hash(projectDir + topic)）已有条目（任何 status）只跳过不覆盖；
 * 来源缺失的主题计入 skipped（source-absent）。重跑幂等：第二次 written = 0。
 */
export async function draftProjectMemory(
  db: MemoryEntryDatabase,
  options: ProjectMemoryDraftOptions,
): Promise<ProjectMemoryDraftResult> {
  const projectDir = path.resolve(options.projectDir);
  const now = options.now ?? Date.now();
  const expectedTopics: ProjectMemoryDraftTopic[] = ['tech-stack', 'directory-layout', 'common-commands', 'readme-purpose'];
  const factsByTopic = new Map((await collectDraftFacts(projectDir)).map((facts) => [facts.topic, facts]));

  const existingIds = new Set((await listUnifiedMemoryEntries(db)).entries.map((entry) => entry.id));
  const skipped: ProjectMemoryDraftResult['skipped'] = [];
  const entries: MemoryEntry[] = [];

  for (const topic of expectedTopics) {
    const facts = factsByTopic.get(topic);
    if (!facts) {
      skipped.push({ topic, reason: 'source-absent' });
      continue;
    }
    if (existingIds.has(draftEntryId(projectDir, topic))) {
      skipped.push({ topic, reason: 'existing-key' });
      continue;
    }
    entries.push(draftEntry(projectDir, facts, now));
  }

  for (const entry of entries) {
    await writeEntryToLightMemory(entry);
  }
  if (entries.length > 0) {
    await rebuildMemoryMirrorFromLightFiles(db);
  }

  return { projectDir, written: entries.length, skipped, entries };
}

/** 自取数据库的入口：CLI 命令端口与 IPC handler 共用 draftProjectMemory 这一条真源。 */
export async function runProjectMemoryDraft(
  projectDir: string,
  options: Omit<ProjectMemoryDraftOptions, 'projectDir'> = {},
): Promise<ProjectMemoryDraftResult> {
  const { getDatabase } = await import('../services');
  return draftProjectMemory(getDatabase(), { ...options, projectDir });
}
