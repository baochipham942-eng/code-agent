import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import Database from 'better-sqlite3';
import { getUserConfigDir, CONFIG_DIR_LEGACY, CONFIG_DIR_NEW } from '../config/configPaths';
import { createLogger } from '../services/infra/logger';
import {
  configureFolderTrustService as configureFolderTrustServiceOptions,
  getFolderTrustServiceOptions,
} from './folderTrustServiceConfig';

const logger = createLogger('FolderTrustService');
const realpathNative = promisify(fs.realpath.native);

export type FolderTrustDecisionState = 'trusted' | 'blocked';
type FolderTrustState = FolderTrustDecisionState | 'untrusted';

export type DangerousConfigKind =
  | 'project-hooks'
  | 'project-mcp'
  | 'project-mcp-local'
  | 'project-agents'
  | 'project-skills'
  | 'project-skill-preferences'
  | 'project-commands'
  | 'project-profile'
  | 'agent-instructions'
  | 'project-policy'
  | 'other-project-config';

type DangerousConfigRisk = 'execution' | 'mcp' | 'prompt' | 'policy' | 'preference' | 'diagnostic';

export interface DangerousConfigItem {
  kind: DangerousConfigKind;
  path: string;
  displayPath: string;
  risk: DangerousConfigRisk;
  /** 未启用时是否拦下来问用户。只有会自己动起来的才拦，见 isGatedRisk。 */
  gated: boolean;
  /** 用于文案「N 个……」，只在数得出来的项上有值。 */
  count?: number;
}

export interface FolderTrustEvaluation {
  state: FolderTrustState;
  canonicalRealpath: string;
  displayPath: string;
  dangerousItems: DangerousConfigItem[];
  blockedItems: DangerousConfigItem[];
  identityChanged: boolean;
  /** 已启用的文件夹后来多出了 gated 项（如空目录建成空间后 clone 进别人的仓库）。 */
  contentChanged: boolean;
}

interface FolderTrustRow {
  canonical_realpath: string;
  display_path: string;
  state: FolderTrustDecisionState;
  created_at: number;
  updated_at: number;
  decided_by: string;
  dev: string | null;
  ino: string | null;
  birthtime_ns: string | null;
  gated_digest: string | null;
}

interface FolderIdentity {
  dev: string;
  ino: string;
  birthtimeNs: string | null;
}

type SqliteDatabase = Database.Database;

const POLICY_FILENAME = 'code-agent-policy.toml';
const AGENT_INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', '.agents.md', '.claude.md'];
const SKIP_DISCOVERY_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'vendor',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '__pycache__',
  '.venv',
  'venv',
  'env',
  '.env',
  'target',
  'Pods',
  '.idea',
  '.vscode',
]);
const MAX_AGENT_INSTRUCTION_DEPTH = 5;
/** 同步路径目录扫描缓存的保质期。见 syncDangerousItemsCache 的注释。 */
const SYNC_SCAN_CACHE_TTL_MS = 5_000;
const PAYLOAD_SCAN_DEPTH = 3;
const MAX_PAYLOAD_SCAN_ENTRIES = 200;
/** Finder 自己撒的元数据，不是谁放进来的附件。 */
const IGNORED_PAYLOAD_FILES = new Set(['.DS_Store']);
const MAX_AGENT_INSTRUCTION_FILES = 32;
const TRUST_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS folder_trust (
    canonical_realpath TEXT PRIMARY KEY,
    display_path TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('trusted', 'blocked')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    decided_by TEXT NOT NULL,
    dev TEXT,
    ino TEXT,
    birthtime_ns TEXT,
    gated_digest TEXT
  )
`;

function toDisplayPath(filePath: string, workingDirectory: string): string {
  const relative = path.relative(workingDirectory, filePath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : filePath;
}

function asErrno(error: unknown): NodeJS.ErrnoException | undefined {
  return error && typeof error === 'object' ? error as NodeJS.ErrnoException : undefined;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readTextFile(filePath: string): Promise<string | undefined> {
  try {
    return await fsp.readFile(filePath, 'utf-8');
  } catch {
    return undefined;
  }
}

function readTextFileSync(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return undefined;
  }
}

function existsSync(filePath: string): boolean {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

async function countDirectoryEntries(dir: string, predicate: (entry: fs.Dirent) => boolean): Promise<number> {
  try {
    return (await fsp.readdir(dir, { withFileTypes: true })).filter(predicate).length;
  } catch {
    return 0;
  }
}

async function findAgentInstructionFiles(rootDir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_AGENT_INSTRUCTION_DEPTH || files.length >= MAX_AGENT_INSTRUCTION_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const fileName of AGENT_INSTRUCTION_FILES) {
      if (entries.some((entry) => entry.isFile() && entry.name === fileName)) {
        files.push(path.join(dir, fileName));
        if (files.length >= MAX_AGENT_INSTRUCTION_FILES) return;
      }
    }

    for (const entry of entries) {
      if (files.length >= MAX_AGENT_INSTRUCTION_FILES) return;
      if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_DISCOVERY_DIRS.has(entry.name)) continue;
      await walk(path.join(dir, entry.name), depth + 1);
    }
  }

  await walk(rootDir, 0);
  return files;
}

function findAgentInstructionFilesSync(rootDir: string): string[] {
  const files: string[] = [];

  function walk(dir: string, depth: number): void {
    if (depth > MAX_AGENT_INSTRUCTION_DEPTH || files.length >= MAX_AGENT_INSTRUCTION_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const fileName of AGENT_INSTRUCTION_FILES) {
      if (entries.some((entry) => entry.isFile() && entry.name === fileName)) {
        files.push(path.join(dir, fileName));
        if (files.length >= MAX_AGENT_INSTRUCTION_FILES) return;
      }
    }

    for (const entry of entries) {
      if (files.length >= MAX_AGENT_INSTRUCTION_FILES) return;
      if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_DISCOVERY_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), depth + 1);
    }
  }

  walk(rootDir, 0);
  return files;
}

function countDirectoryEntriesSync(dir: string, predicate: (entry: fs.Dirent) => boolean): number {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter(predicate).length;
  } catch {
    return 0;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 只有「会自己动起来」的配置才拦下来问用户：
 * execution（hooks / 旧版 settings 里的 hooks）、mcp（stdio 类，会在本机起进程）、
 * policy（改的是护栏本身，自己的空间里也要显式告知）。
 * prompt/preference/diagnostic 不拦——CLAUDE.md、AGENTS.md 恰恰是最常见的一类，
 * 拦它等于绝大多数触发都在用最高警戒级别报一件几乎无害的事（爸 2026-09-05 拍板）。
 */
function isGatedRisk(risk: DangerousConfigRisk): boolean {
  return risk === 'execution' || risk === 'mcp' || risk === 'policy';
}

/**
 * 技能 / 专家设定目录里除了 .md 还有没有别的东西。有 ⇒ 按「会跑起来」处理。
 *
 * 不按后缀白名单认脚本：白名单永远漏一类——`SKILL.md` 只要写一句「跑 scripts/payload.txt」，
 * 一个 `.txt` 就是脚本（ai-review PR#1644 第二轮抓的就是这个），何况按名字枚举的拒绝清单
 * 本来就是漏洞制造机。这里只认「全是 .md」这一种安全形状，其余一律拦。
 * 扫不完（超过上限）同样按「有」算 —— 这一格必须 fail-closed。
 */
async function hasNonMarkdownPayload(rootDir: string): Promise<boolean> {
  let scanned = 0;
  async function walk(dir: string, depth: number): Promise<boolean> {
    if (depth > PAYLOAD_SCAN_DEPTH) return true; // 深到扫不下去了，同样不敢说「里面全是说明文字」
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (++scanned > MAX_PAYLOAD_SCAN_ENTRIES) return true;
      if (entry.isDirectory()) {
        if (await walk(path.join(dir, entry.name), depth + 1)) return true;
        continue;
      }
      if (IGNORED_PAYLOAD_FILES.has(entry.name)) continue;
      if (path.extname(entry.name).toLowerCase() !== '.md') return true;
    }
    return false;
  }
  return walk(rootDir, 0);
}

function hasNonMarkdownPayloadSync(rootDir: string): boolean {
  let scanned = 0;
  function walk(dir: string, depth: number): boolean {
    if (depth > PAYLOAD_SCAN_DEPTH) return true;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (++scanned > MAX_PAYLOAD_SCAN_ENTRIES) return true;
      if (entry.isDirectory()) {
        if (walk(path.join(dir, entry.name), depth + 1)) return true;
        continue;
      }
      if (IGNORED_PAYLOAD_FILES.has(entry.name)) continue;
      if (path.extname(entry.name).toLowerCase() !== '.md') return true;
    }
    return false;
  }
  return walk(rootDir, 0);
}

/**
 * 数会在本机起进程的 MCP server（带 command 的 stdio 类）。远端 url 类不起进程 ⇒ 不拦。
 * 两种文件格式都认（原生 servers 数组 / Claude Code 兼容 mcpServers 对象，见 mcpConfigFile.ts）。
 * 读不懂的文件按 1 算：宁可多问一次，也不能因为解析不了就放行。
 */
function countStdioMcpServers(text: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 1;
  }
  if (!isRecord(parsed)) return 1;
  const entries: unknown[] = [];
  if (Array.isArray(parsed.servers)) entries.push(...(parsed.servers as unknown[]));
  if (isRecord(parsed.mcpServers)) entries.push(...Object.values(parsed.mcpServers));
  return entries.filter((entry) => isRecord(entry) && typeof entry.command === 'string' && entry.command.length > 0).length;
}

/**
 * 数 hooks 文件里会自动跑的命令条数。读不懂按 1 算（fail-closed：宁可多问一次）。
 *
 * `.code-agent/hooks/hooks.json` 整个文件就是 hooks，拦不拦只看它在不在——解析口径万一
 * 跟 configParser 漂了，按条数放行就是 fail-open，这条主路不冒这个险；空文件报 1 条是
 * 有意的高报（ponytail: 要精确就跟 configParser 共用解析）。
 * 旧版 `.claude/settings.json` 不一样：Neo 只读它的 hooks 段（见 configParser 的
 * settings-json 分支），只带 permissions 的那种在 Neo 这儿一行都不会跑，返回 0 让调用方跳过——
 * 这类文件在 Claude Code 仓里遍地都是，为它弹一次最高警戒的窗纯属噪音。
 */
function countHookCommands(text: string, legacy: boolean): number {
  let config: unknown;
  try {
    const parsed: unknown = JSON.parse(text);
    config = legacy ? (isRecord(parsed) ? parsed.hooks : undefined) : parsed;
  } catch {
    return 1;
  }
  if (!isRecord(config)) return legacy ? 0 : 1;
  let count = 0;
  for (const matchers of Object.values(config)) {
    if (!Array.isArray(matchers)) continue;
    for (const matcher of matchers) {
      if (isRecord(matcher) && Array.isArray(matcher.hooks)) count += matcher.hooks.length;
    }
  }
  return legacy ? count : Math.max(1, count);
}

function itemKey(item: DangerousConfigItem): string {
  return `${item.kind}\0${item.path}`;
}

/** 决定落库时拍下的 gated 项快照，用于事后发现「多出了会自动运行的东西」。 */
function gatedDigestOf(items: DangerousConfigItem[]): string {
  return JSON.stringify(items.filter((item) => item.gated).map(itemKey).sort());
}

function hasNewGatedItems(storedDigest: string | null | undefined, items: DangerousConfigItem[]): boolean {
  if (!storedDigest) return false; // 本次改动之前落的决定没有快照：不追溯，避免升级后集体重问
  let known: unknown;
  try {
    known = JSON.parse(storedDigest);
  } catch {
    return false;
  }
  if (!Array.isArray(known)) return false;
  const knownKeys = new Set(known as string[]);
  return items.some((item) => item.gated && !knownKeys.has(itemKey(item)));
}

function pushItem(
  items: DangerousConfigItem[],
  workingDirectory: string,
  kind: DangerousConfigKind,
  filePath: string,
  risk: DangerousConfigRisk,
  extra: { gated?: boolean; count?: number } = {},
): void {
  items.push({
    kind,
    path: filePath,
    displayPath: toDisplayPath(filePath, workingDirectory),
    risk,
    gated: extra.gated ?? isGatedRisk(risk),
    ...(extra.count === undefined ? {} : { count: extra.count }),
  });
}

export class FolderTrustService {
  private db: SqliteDatabase | null = null;
  readonly defaultProjectConfigTrust: boolean | undefined;
  /**
   * discoverDangerousItemsSync 的进程级缓存（key = canonical realpath，带 SYNC_SCAN_CACHE_TTL_MS 保质期）。
   * 技能发现等热点路径会对同一目录反复评估（每个 skill 一次），而单次发现要
   * 深度 5 递归扫描整个工作目录（实测 266 skill × ~18ms ≈ 5s 纯同步 IO，
   * 把 CLI 首屏饿死）。只缓存目录扫描产物，不缓存评估结论——trust 决策
   * （folder_trust 表）与 identity 每次现读（DB/stat，廉价），决策变更即时生效。
   *
   * 目录内容变化只在 TTL 内看不见：内容变化是要重新问用户的
   * （contentChanged，N-FOLDERTRUST-RISKTIER ③），而 policy/soul 走的正是这条同步路径——
   * 缓存不过期的话，已信任目录里新落盘的 code-agent-policy.toml 会在本进程内一直不被发现、
   * 未经确认就生效（ai-review PR#1644 第三轮抓出）。TTL 取几秒：技能发现那种一次性突发
   * （266 skill × ~18ms）仍然只扫一两次，运行期真出现新配置最多迟几秒被看见。
   */
  private readonly syncDangerousItemsCache = new Map<string, { items: DangerousConfigItem[]; scannedAt: number }>();

  constructor(options: { defaultProjectConfigTrust?: boolean } = {}) {
    this.defaultProjectConfigTrust = options.defaultProjectConfigTrust;
  }

  async evaluate(workingDirectory: string): Promise<FolderTrustEvaluation> {
    const canonicalRealpath = await realpathNative(workingDirectory);
    const identity = await this.readIdentity(canonicalRealpath);
    const dangerousItems = await this.discoverDangerousItems(canonicalRealpath);
    return this.buildEvaluation(canonicalRealpath, workingDirectory, identity, dangerousItems);
  }

  evaluateSync(workingDirectory: string): FolderTrustEvaluation {
    const canonicalRealpath = fs.realpathSync.native(workingDirectory);
    const identity = this.readIdentitySync(canonicalRealpath);
    return this.buildEvaluation(
      canonicalRealpath,
      workingDirectory,
      identity,
      this.cachedDangerousItemsSync(canonicalRealpath),
    );
  }

  private cachedDangerousItemsSync(canonicalRealpath: string): DangerousConfigItem[] {
    const cached = this.syncDangerousItemsCache.get(canonicalRealpath);
    if (cached && Date.now() - cached.scannedAt < SYNC_SCAN_CACHE_TTL_MS) return cached.items;
    const items = this.discoverDangerousItemsSync(canonicalRealpath);
    this.syncDangerousItemsCache.set(canonicalRealpath, { items, scannedAt: Date.now() });
    return items;
  }

  async set(
    workingDirectory: string,
    state: FolderTrustDecisionState,
    decidedBy = 'user',
  ): Promise<FolderTrustEvaluation> {
    const canonicalRealpath = await realpathNative(workingDirectory);
    const identity = await this.readIdentity(canonicalRealpath);
    const dangerousItems = await this.discoverDangerousItems(canonicalRealpath);
    // 决定与快照都出自这一次扫描：同步缓存要是还留着更旧的一份，下一次 evaluateSync 会拿
    // 缓存里多出来的 gated 项跟新快照比，误判成「内容变了」。用刚扫到的这份覆盖掉。
    this.syncDangerousItemsCache.set(canonicalRealpath, { items: dangerousItems, scannedAt: Date.now() });
    this.upsertDecision(canonicalRealpath, workingDirectory, state, decidedBy, identity, gatedDigestOf(dangerousItems));
    return this.buildEvaluation(canonicalRealpath, workingDirectory, identity, dangerousItems);
  }

  setSync(
    workingDirectory: string,
    state: FolderTrustDecisionState,
    decidedBy = 'user',
  ): FolderTrustEvaluation {
    const canonicalRealpath = fs.realpathSync.native(workingDirectory);
    const identity = this.readIdentitySync(canonicalRealpath);
    const dangerousItems = this.cachedDangerousItemsSync(canonicalRealpath);
    this.upsertDecision(canonicalRealpath, workingDirectory, state, decidedBy, identity, gatedDigestOf(dangerousItems));
    return this.buildEvaluation(canonicalRealpath, workingDirectory, identity, dangerousItems);
  }

  async revoke(workingDirectory: string): Promise<FolderTrustEvaluation> {
    return this.set(workingDirectory, 'blocked', 'user');
  }

  revokeSync(workingDirectory: string): FolderTrustEvaluation {
    return this.setSync(workingDirectory, 'blocked', 'user');
  }

  close(): void {
    this.syncDangerousItemsCache.clear();
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private getDb(): SqliteDatabase {
    if (this.db) return this.db;
    const dbPath = path.join(getUserConfigDir(), 'code-agent.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    try {
      db.pragma('journal_mode = WAL');
      db.exec(TRUST_TABLE_SQL);
      // CREATE TABLE IF NOT EXISTS 不会给既有表补列：老库在这里加上，加过就抛、忽略即可。
      try {
        db.exec('ALTER TABLE folder_trust ADD COLUMN gated_digest TEXT');
      } catch {
        // 列已存在
      }
      db.transaction(() => {
        const columns = db.prepare('PRAGMA table_info(folder_trust)').all() as { name: string }[];
        if (!columns.some((column) => column.name === 'birthtime_ns')) {
          // Old grants require confirmation; old denials remain blocked.
          db.exec('ALTER TABLE folder_trust ADD COLUMN birthtime_ns TEXT');
        }
      }).immediate();
      // Publish only a fully initialized connection, so transient migration errors can retry.
      this.db = db;
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private getRow(canonicalRealpath: string): FolderTrustRow | undefined {
    return this.getDb()
      .prepare('SELECT * FROM folder_trust WHERE canonical_realpath = ?')
      .get(canonicalRealpath) as FolderTrustRow | undefined;
  }

  private upsertDecision(
    canonicalRealpath: string,
    displayPath: string,
    state: FolderTrustDecisionState,
    decidedBy: string,
    identity: FolderIdentity,
    gatedDigest: string,
  ): void {
    if (state === 'trusted' && !identity.birthtimeNs) {
      // The existing IPC error/toast path must explain why an explicit grant failed.
      throw new Error('This filesystem does not provide folder creation time. Folder trust cannot be saved. Choose a folder on a filesystem that supports creation times.');
    }
    const now = Date.now();
    this.getDb().prepare(`
      INSERT INTO folder_trust (
        canonical_realpath,
        display_path,
        state,
        created_at,
        updated_at,
        decided_by,
        dev,
        ino,
        birthtime_ns,
        gated_digest
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(canonical_realpath) DO UPDATE SET
        display_path = excluded.display_path,
        state = excluded.state,
        updated_at = excluded.updated_at,
        decided_by = excluded.decided_by,
        dev = excluded.dev,
        ino = excluded.ino,
        birthtime_ns = excluded.birthtime_ns,
        gated_digest = excluded.gated_digest
    `).run(
      canonicalRealpath,
      displayPath,
      state,
      now,
      now,
      decidedBy,
      identity.dev,
      identity.ino,
      identity.birthtimeNs,
      gatedDigest,
    );
  }

  private async readIdentity(canonicalRealpath: string): Promise<FolderIdentity> {
    const stat = await fsp.stat(canonicalRealpath, { bigint: true });
    return {
      dev: String(stat.dev),
      ino: String(stat.ino),
      birthtimeNs: stat.birthtimeNs > 0n ? String(stat.birthtimeNs) : null,
    };
  }

  private readIdentitySync(canonicalRealpath: string): FolderIdentity {
    const stat = fs.statSync(canonicalRealpath, { bigint: true });
    return {
      dev: String(stat.dev),
      ino: String(stat.ino),
      birthtimeNs: stat.birthtimeNs > 0n ? String(stat.birthtimeNs) : null,
    };
  }

  /**
   * inode can be recycled after deletion. Bind the decision to its creation time too,
   * preserving stat's full precision (Date/Number milliseconds can hide a replacement).
   * On filesystems with real birthtime (not Node's ctime fallback), ordinary edits
   * leave it stable; ctime/mtime and content digests do not identify an incarnation.
   * Missing snapshots fail closed; never seed an old grant from the current directory.
   * dev alone is not identity: APFS reassigns it on remount/reboot.
   */
  private identityChanged(row: FolderTrustRow | undefined, identity: FolderIdentity): boolean {
    if (!row) return false;
    return row.ino !== identity.ino
      || !row.birthtime_ns
      || !identity.birthtimeNs
      || row.birthtime_ns !== identity.birthtimeNs;
  }

  /** dev 单独变化（卷重挂载/重启）：把新 dev 写回，保持记录与现实一致，不改 state/decidedBy。 */
  private rebindDevice(canonicalRealpath: string, dev: string): void {
    this.getDb()
      .prepare('UPDATE folder_trust SET dev = ? WHERE canonical_realpath = ?')
      .run(dev, canonicalRealpath);
  }

  private buildEvaluation(
    canonicalRealpath: string,
    displayPath: string,
    identity: FolderIdentity,
    dangerousItems: DangerousConfigItem[],
  ): FolderTrustEvaluation {
    const row = this.getRow(canonicalRealpath);
    const identityChanged = this.identityChanged(row, identity);
    // inode 与出生时间都一致，只有 dev 变了：按卷重挂载就地重绑。
    if (row && !identityChanged && row.dev !== identity.dev) {
      this.rebindDevice(canonicalRealpath, identity.dev);
    }
    // 已启用的目录后来多出 gated 项 = 当时那句「启用」没覆盖到的东西（空目录建成空间后
    // clone 进别人的仓库就是这条路），降回未决定再问一次。identityChanged 只认目录身份，看不见这个。
    const contentChanged = !!row
      && row.state === 'trusted'
      && !identityChanged
      && hasNewGatedItems(row.gated_digest, dangerousItems);
    // Losing identity evidence can revoke a grant, but must never relax an explicit denial.
    const state: FolderTrustState = row?.state === 'blocked'
      ? 'blocked'
      : row && !identityChanged && !contentChanged ? row.state : 'untrusted';
    const blockedItems = state === 'trusted' ? [] : dangerousItems.filter((item) => item.gated);
    return {
      state,
      canonicalRealpath,
      displayPath,
      dangerousItems,
      blockedItems,
      identityChanged,
      contentChanged,
    };
  }

  private async discoverDangerousItems(workingDirectory: string): Promise<DangerousConfigItem[]> {
    const items: DangerousConfigItem[] = [];
    const codeAgentDir = path.join(workingDirectory, CONFIG_DIR_NEW);
    const claudeDir = path.join(workingDirectory, CONFIG_DIR_LEGACY);

    for (const [hooksFile, legacy] of [
      [path.join(codeAgentDir, 'hooks', 'hooks.json'), false],
      [path.join(claudeDir, 'settings.json'), true],
    ] as const) {
      const text = await readTextFile(hooksFile);
      if (text === undefined) continue;
      const hookCount = countHookCommands(text, legacy);
      if (hookCount === 0) continue;
      pushItem(items, workingDirectory, 'project-hooks', hooksFile, 'execution', { count: hookCount });
    }

    for (const [mcpKind, mcpPath] of [
      ['project-mcp', path.join(codeAgentDir, 'mcp.json')],
      ['project-mcp-local', path.join(codeAgentDir, 'mcp.local.json')],
    ] as const) {
      const text = await readTextFile(mcpPath);
      if (text === undefined) continue;
      const stdioCount = countStdioMcpServers(text);
      pushItem(items, workingDirectory, mcpKind, mcpPath, 'mcp', {
        gated: stdioCount > 0,
        count: stdioCount,
      });
    }

    const agentsDir = path.join(codeAgentDir, 'agents');
    const agentCount = await countDirectoryEntries(agentsDir, (entry) => entry.isFile() && entry.name.endsWith('.md'));
    if (agentCount > 0) {
      const executable = await hasNonMarkdownPayload(agentsDir);
      pushItem(items, workingDirectory, 'project-agents', agentsDir, executable ? 'execution' : 'prompt', {
        count: agentCount,
      });
    }

    for (const skillsDir of [path.join(codeAgentDir, 'skills'), path.join(claudeDir, 'skills')]) {
      const skillCount = await countDirectoryEntries(skillsDir, (entry) => entry.isDirectory());
      if (skillCount === 0) continue;
      const executable = await hasNonMarkdownPayload(skillsDir);
      pushItem(items, workingDirectory, 'project-skills', skillsDir, executable ? 'execution' : 'prompt', {
        count: skillCount,
      });
    }

    const skillPrefsPath = path.join(codeAgentDir, 'skill-preferences.json');
    if (await exists(skillPrefsPath)) {
      pushItem(items, workingDirectory, 'project-skill-preferences', skillPrefsPath, 'preference');
    }

    const commandsDir = path.join(codeAgentDir, 'commands');
    const commandCount = await countDirectoryEntries(
      commandsDir,
      (entry) => entry.isFile() && entry.name.endsWith('.md') && !entry.name.startsWith('.'),
    );
    if (commandCount > 0) {
      pushItem(items, workingDirectory, 'project-commands', commandsDir, 'prompt', { count: commandCount });
    }

    const profilePath = path.join(codeAgentDir, 'PROFILE.md');
    if (await exists(profilePath)) {
      pushItem(items, workingDirectory, 'project-profile', profilePath, 'prompt');
    }

    for (const filePath of await findAgentInstructionFiles(workingDirectory)) {
      pushItem(items, workingDirectory, 'agent-instructions', filePath, 'prompt');
    }

    const policyPath = path.join(workingDirectory, POLICY_FILENAME);
    if (await exists(policyPath)) {
      pushItem(items, workingDirectory, 'project-policy', policyPath, 'policy');
    }

    for (const fileName of ['capabilities.json', 'rules.json', 'settings.json']) {
      const filePath = path.join(codeAgentDir, fileName);
      if (await exists(filePath)) {
        pushItem(items, workingDirectory, 'other-project-config', filePath, 'diagnostic');
      }
    }

    return this.dedupeItems(items);
  }

  private discoverDangerousItemsSync(workingDirectory: string): DangerousConfigItem[] {
    const items: DangerousConfigItem[] = [];
    const codeAgentDir = path.join(workingDirectory, CONFIG_DIR_NEW);
    const claudeDir = path.join(workingDirectory, CONFIG_DIR_LEGACY);

    for (const [hooksFile, legacy] of [
      [path.join(codeAgentDir, 'hooks', 'hooks.json'), false],
      [path.join(claudeDir, 'settings.json'), true],
    ] as const) {
      const text = readTextFileSync(hooksFile);
      if (text === undefined) continue;
      const hookCount = countHookCommands(text, legacy);
      if (hookCount === 0) continue;
      pushItem(items, workingDirectory, 'project-hooks', hooksFile, 'execution', { count: hookCount });
    }

    for (const [mcpKind, mcpPath] of [
      ['project-mcp', path.join(codeAgentDir, 'mcp.json')],
      ['project-mcp-local', path.join(codeAgentDir, 'mcp.local.json')],
    ] as const) {
      const text = readTextFileSync(mcpPath);
      if (text === undefined) continue;
      const stdioCount = countStdioMcpServers(text);
      pushItem(items, workingDirectory, mcpKind, mcpPath, 'mcp', {
        gated: stdioCount > 0,
        count: stdioCount,
      });
    }

    const agentsDir = path.join(codeAgentDir, 'agents');
    const agentCount = countDirectoryEntriesSync(agentsDir, (entry) => entry.isFile() && entry.name.endsWith('.md'));
    if (agentCount > 0) {
      const executable = hasNonMarkdownPayloadSync(agentsDir);
      pushItem(items, workingDirectory, 'project-agents', agentsDir, executable ? 'execution' : 'prompt', {
        count: agentCount,
      });
    }

    for (const skillsDir of [path.join(codeAgentDir, 'skills'), path.join(claudeDir, 'skills')]) {
      const skillCount = countDirectoryEntriesSync(skillsDir, (entry) => entry.isDirectory());
      if (skillCount === 0) continue;
      const executable = hasNonMarkdownPayloadSync(skillsDir);
      pushItem(items, workingDirectory, 'project-skills', skillsDir, executable ? 'execution' : 'prompt', {
        count: skillCount,
      });
    }

    const skillPrefsPath = path.join(codeAgentDir, 'skill-preferences.json');
    if (existsSync(skillPrefsPath)) {
      pushItem(items, workingDirectory, 'project-skill-preferences', skillPrefsPath, 'preference');
    }

    const commandsDir = path.join(codeAgentDir, 'commands');
    const commandCount = countDirectoryEntriesSync(
      commandsDir,
      (entry) => entry.isFile() && entry.name.endsWith('.md') && !entry.name.startsWith('.'),
    );
    if (commandCount > 0) {
      pushItem(items, workingDirectory, 'project-commands', commandsDir, 'prompt', { count: commandCount });
    }

    const profilePath = path.join(codeAgentDir, 'PROFILE.md');
    if (existsSync(profilePath)) {
      pushItem(items, workingDirectory, 'project-profile', profilePath, 'prompt');
    }

    for (const filePath of findAgentInstructionFilesSync(workingDirectory)) {
      pushItem(items, workingDirectory, 'agent-instructions', filePath, 'prompt');
    }

    const policyPath = path.join(workingDirectory, POLICY_FILENAME);
    if (existsSync(policyPath)) {
      pushItem(items, workingDirectory, 'project-policy', policyPath, 'policy');
    }

    for (const fileName of ['capabilities.json', 'rules.json', 'settings.json']) {
      const filePath = path.join(codeAgentDir, fileName);
      if (existsSync(filePath)) {
        pushItem(items, workingDirectory, 'other-project-config', filePath, 'diagnostic');
      }
    }

    return this.dedupeItems(items);
  }

  private dedupeItems(items: DangerousConfigItem[]): DangerousConfigItem[] {
    const seen = new Set<string>();
    return items.filter((item) => {
      const key = `${item.kind}\0${item.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}

let singleton: FolderTrustService | null = null;

function getFolderTrustService(): FolderTrustService {
  const options = getFolderTrustServiceOptions();
  if (singleton?.defaultProjectConfigTrust !== options.defaultProjectConfigTrust) {
    closeFolderTrustService();
  }
  if (!singleton) singleton = new FolderTrustService(options);
  return singleton;
}

/**
 * 关闭本服务持有的主库连接。退出路径必须调用 —— 本服务对
 * `<userConfigDir>/code-agent.db` 开了一条独立连接，不关的话
 * SQLite 不会删 -wal/-shm（见 src/web/webShutdownDatabases.ts）。
 */
export function closeFolderTrustService(): void {
  if (singleton) singleton.close();
  singleton = null;
}

export function resetFolderTrustServiceForTest(): void {
  closeFolderTrustService();
  configureFolderTrustServiceOptions({});
}

export async function evaluateFolderTrust(workingDirectory: string): Promise<FolderTrustEvaluation> {
  return getFolderTrustService().evaluate(workingDirectory);
}

function evaluateFolderTrustSync(workingDirectory: string): FolderTrustEvaluation {
  return getFolderTrustService().evaluateSync(workingDirectory);
}

export async function setFolderTrust(
  workingDirectory: string,
  state: FolderTrustDecisionState,
  decidedBy?: string,
): Promise<FolderTrustEvaluation> {
  return getFolderTrustService().set(workingDirectory, state, decidedBy);
}

export async function revokeFolderTrust(workingDirectory: string): Promise<FolderTrustEvaluation> {
  return getFolderTrustService().revoke(workingDirectory);
}

/**
 * 未启用的目录里，这一类配置是不是本来就不拦。
 *
 * 弹窗只问 gated 项（会自己动起来的那几类），prompt 类不再问——所以这里也必须放行，
 * 否则 CLAUDE.md 这类文件就落进「既不问、也永远不加载」的静默失效：用户看不到任何提示，
 * 只会觉得说明文件没生效。要求该类确实发现到了项才放行（一个都没发现说明扫描本身没看到，
 * 按 fail-closed 继续拦），且该类里但凡有一项是 gated 就整类拦下。
 */
function allowsUngatedKind(evaluation: FolderTrustEvaluation, kind?: DangerousConfigKind): boolean {
  if (!kind || evaluation.state !== 'untrusted') return false;
  const ofKind = evaluation.dangerousItems.filter((item) => item.kind === kind);
  return ofKind.length > 0 && ofKind.every((item) => !item.gated);
}

export async function isProjectConfigTrusted(workingDirectory: string, kind?: DangerousConfigKind): Promise<boolean> {
  const defaultTrust = getFolderTrustService().defaultProjectConfigTrust;
  if (defaultTrust !== undefined) return defaultTrust;

  try {
    const evaluation = await evaluateFolderTrust(workingDirectory);
    if (evaluation.state === 'trusted') return true;
    if (allowsUngatedKind(evaluation, kind)) return true;
    logBlockedProjectConfig(evaluation, kind);
    return false;
  } catch (error) {
    const code = asErrno(error)?.code;
    logger.warn('Folder trust evaluation failed; blocking project config', {
      workingDirectory,
      kind,
      error: error instanceof Error ? error.message : String(error),
      code,
    });
    return false;
  }
}

export function isProjectConfigTrustedSync(workingDirectory: string, kind?: DangerousConfigKind): boolean {
  const defaultTrust = getFolderTrustService().defaultProjectConfigTrust;
  if (defaultTrust !== undefined) return defaultTrust;

  try {
    const evaluation = evaluateFolderTrustSync(workingDirectory);
    if (evaluation.state === 'trusted') return true;
    if (allowsUngatedKind(evaluation, kind)) return true;
    logBlockedProjectConfig(evaluation, kind);
    return false;
  } catch (error) {
    const code = asErrno(error)?.code;
    logger.warn('Folder trust evaluation failed; blocking project config', {
      workingDirectory,
      kind,
      error: error instanceof Error ? error.message : String(error),
      code,
    });
    return false;
  }
}

function logBlockedProjectConfig(evaluation: FolderTrustEvaluation, kind?: DangerousConfigKind): void {
  const blocked = kind
    ? evaluation.blockedItems.filter((item) => item.kind === kind)
    : evaluation.blockedItems;
  if (blocked.length === 0) return;
  logger.warn('Blocked project configuration from untrusted folder', {
    state: evaluation.state,
    canonicalRealpath: evaluation.canonicalRealpath,
    identityChanged: evaluation.identityChanged,
    items: blocked.map((item) => ({ kind: item.kind, path: item.path })),
  });
}
