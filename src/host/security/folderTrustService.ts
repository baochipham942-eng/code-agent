import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import Database from 'better-sqlite3';
import { getUserConfigDir, CONFIG_DIR_LEGACY, CONFIG_DIR_NEW } from '../config/configPaths';
import { createLogger } from '../services/infra/logger';

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

export interface DangerousConfigItem {
  kind: DangerousConfigKind;
  path: string;
  displayPath: string;
  label: string;
  risk: 'execution' | 'mcp' | 'agent' | 'skill' | 'prompt' | 'policy' | 'preference' | 'diagnostic';
  gated: boolean;
}

export interface FolderTrustEvaluation {
  state: FolderTrustState;
  canonicalRealpath: string;
  displayPath: string;
  dangerousItems: DangerousConfigItem[];
  blockedItems: DangerousConfigItem[];
  identityChanged: boolean;
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
}

interface FolderIdentity {
  dev: string;
  ino: string;
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
    ino TEXT
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

function existsSync(filePath: string): boolean {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

async function hasDirectoryEntries(dir: string, predicate?: (entry: fs.Dirent) => boolean): Promise<boolean> {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return predicate ? entries.some(predicate) : entries.length > 0;
  } catch {
    return false;
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

function hasDirectoryEntriesSync(dir: string, predicate?: (entry: fs.Dirent) => boolean): boolean {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return predicate ? entries.some(predicate) : entries.length > 0;
  } catch {
    return false;
  }
}

function pushItem(
  items: DangerousConfigItem[],
  workingDirectory: string,
  kind: DangerousConfigKind,
  filePath: string,
  label: string,
  risk: DangerousConfigItem['risk'],
  gated = true,
): void {
  items.push({
    kind,
    path: filePath,
    displayPath: toDisplayPath(filePath, workingDirectory),
    label,
    risk,
    gated,
  });
}

export class FolderTrustService {
  private db: SqliteDatabase | null = null;

  async evaluate(workingDirectory: string): Promise<FolderTrustEvaluation> {
    const canonicalRealpath = await realpathNative(workingDirectory);
    const identity = await this.readIdentity(canonicalRealpath);
    const dangerousItems = await this.discoverDangerousItems(canonicalRealpath);
    return this.buildEvaluation(canonicalRealpath, workingDirectory, identity, dangerousItems);
  }

  evaluateSync(workingDirectory: string): FolderTrustEvaluation {
    const canonicalRealpath = fs.realpathSync.native(workingDirectory);
    const identity = this.readIdentitySync(canonicalRealpath);
    const dangerousItems = this.discoverDangerousItemsSync(canonicalRealpath);
    return this.buildEvaluation(canonicalRealpath, workingDirectory, identity, dangerousItems);
  }

  async set(
    workingDirectory: string,
    state: FolderTrustDecisionState,
    decidedBy = 'user',
  ): Promise<FolderTrustEvaluation> {
    const canonicalRealpath = await realpathNative(workingDirectory);
    const identity = await this.readIdentity(canonicalRealpath);
    this.upsertDecision(canonicalRealpath, workingDirectory, state, decidedBy, identity);
    return this.evaluate(workingDirectory);
  }

  setSync(
    workingDirectory: string,
    state: FolderTrustDecisionState,
    decidedBy = 'user',
  ): FolderTrustEvaluation {
    const canonicalRealpath = fs.realpathSync.native(workingDirectory);
    const identity = this.readIdentitySync(canonicalRealpath);
    this.upsertDecision(canonicalRealpath, workingDirectory, state, decidedBy, identity);
    return this.evaluateSync(workingDirectory);
  }

  async revoke(workingDirectory: string): Promise<FolderTrustEvaluation> {
    return this.set(workingDirectory, 'blocked', 'user');
  }

  revokeSync(workingDirectory: string): FolderTrustEvaluation {
    return this.setSync(workingDirectory, 'blocked', 'user');
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private getDb(): SqliteDatabase {
    if (this.db) return this.db;
    const dbPath = path.join(getUserConfigDir(), 'code-agent.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(TRUST_TABLE_SQL);
    return this.db;
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
  ): void {
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
        ino
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(canonical_realpath) DO UPDATE SET
        display_path = excluded.display_path,
        state = excluded.state,
        updated_at = excluded.updated_at,
        decided_by = excluded.decided_by,
        dev = excluded.dev,
        ino = excluded.ino
    `).run(
      canonicalRealpath,
      displayPath,
      state,
      now,
      now,
      decidedBy,
      identity.dev,
      identity.ino,
    );
  }

  private async readIdentity(canonicalRealpath: string): Promise<FolderIdentity> {
    const stat = await fsp.stat(canonicalRealpath);
    return { dev: String(stat.dev), ino: String(stat.ino) };
  }

  private readIdentitySync(canonicalRealpath: string): FolderIdentity {
    const stat = fs.statSync(canonicalRealpath);
    return { dev: String(stat.dev), ino: String(stat.ino) };
  }

  private identityChanged(row: FolderTrustRow | undefined, identity: FolderIdentity): boolean {
    if (!row) return false;
    return row.dev !== identity.dev || row.ino !== identity.ino;
  }

  private buildEvaluation(
    canonicalRealpath: string,
    displayPath: string,
    identity: FolderIdentity,
    dangerousItems: DangerousConfigItem[],
  ): FolderTrustEvaluation {
    const row = this.getRow(canonicalRealpath);
    const identityChanged = this.identityChanged(row, identity);
    const state: FolderTrustState = row && !identityChanged ? row.state : 'untrusted';
    const blockedItems = state === 'trusted' ? [] : dangerousItems.filter((item) => item.gated);
    return {
      state,
      canonicalRealpath,
      displayPath,
      dangerousItems,
      blockedItems,
      identityChanged,
    };
  }

  private async discoverDangerousItems(workingDirectory: string): Promise<DangerousConfigItem[]> {
    const items: DangerousConfigItem[] = [];
    const codeAgentDir = path.join(workingDirectory, CONFIG_DIR_NEW);
    const claudeDir = path.join(workingDirectory, CONFIG_DIR_LEGACY);

    const hooksPath = path.join(codeAgentDir, 'hooks', 'hooks.json');
    if (await exists(hooksPath)) {
      pushItem(items, workingDirectory, 'project-hooks', hooksPath, 'Project hooks', 'execution');
    }
    const claudeSettingsPath = path.join(claudeDir, 'settings.json');
    if (await exists(claudeSettingsPath)) {
      pushItem(items, workingDirectory, 'project-hooks', claudeSettingsPath, 'Legacy project settings', 'execution');
    }

    const mcpPath = path.join(codeAgentDir, 'mcp.json');
    if (await exists(mcpPath)) {
      pushItem(items, workingDirectory, 'project-mcp', mcpPath, 'Project MCP servers', 'mcp');
    }
    const localMcpPath = path.join(codeAgentDir, 'mcp.local.json');
    if (await exists(localMcpPath)) {
      pushItem(items, workingDirectory, 'project-mcp-local', localMcpPath, 'Local project MCP servers', 'mcp');
    }

    const agentsDir = path.join(codeAgentDir, 'agents');
    if (await hasDirectoryEntries(agentsDir, (entry) => entry.isFile() && entry.name.endsWith('.md'))) {
      pushItem(items, workingDirectory, 'project-agents', agentsDir, 'Project agents', 'agent');
    }

    for (const skillsDir of [path.join(codeAgentDir, 'skills'), path.join(claudeDir, 'skills')]) {
      if (await hasDirectoryEntries(skillsDir, (entry) => entry.isDirectory())) {
        pushItem(items, workingDirectory, 'project-skills', skillsDir, 'Project skills', 'skill');
      }
    }

    const skillPrefsPath = path.join(codeAgentDir, 'skill-preferences.json');
    if (await exists(skillPrefsPath)) {
      pushItem(items, workingDirectory, 'project-skill-preferences', skillPrefsPath, 'Project skill preferences', 'preference');
    }

    const commandsDir = path.join(codeAgentDir, 'commands');
    if (await hasDirectoryEntries(commandsDir, (entry) => entry.isFile() && entry.name.endsWith('.md') && !entry.name.startsWith('.'))) {
      pushItem(items, workingDirectory, 'project-commands', commandsDir, 'Project prompt commands', 'prompt');
    }

    const profilePath = path.join(codeAgentDir, 'PROFILE.md');
    if (await exists(profilePath)) {
      pushItem(items, workingDirectory, 'project-profile', profilePath, 'Project profile prompt', 'prompt');
    }

    for (const filePath of await findAgentInstructionFiles(workingDirectory)) {
      pushItem(items, workingDirectory, 'agent-instructions', filePath, 'Project agent instructions', 'prompt');
    }

    const policyPath = path.join(workingDirectory, POLICY_FILENAME);
    if (await exists(policyPath)) {
      pushItem(items, workingDirectory, 'project-policy', policyPath, 'Project security policy', 'policy');
    }

    for (const fileName of ['capabilities.json', 'rules.json', 'settings.json']) {
      const filePath = path.join(codeAgentDir, fileName);
      if (await exists(filePath)) {
        pushItem(items, workingDirectory, 'other-project-config', filePath, 'Other project configuration', 'diagnostic', false);
      }
    }

    return this.dedupeItems(items);
  }

  private discoverDangerousItemsSync(workingDirectory: string): DangerousConfigItem[] {
    const items: DangerousConfigItem[] = [];
    const codeAgentDir = path.join(workingDirectory, CONFIG_DIR_NEW);
    const claudeDir = path.join(workingDirectory, CONFIG_DIR_LEGACY);

    const hooksPath = path.join(codeAgentDir, 'hooks', 'hooks.json');
    if (existsSync(hooksPath)) pushItem(items, workingDirectory, 'project-hooks', hooksPath, 'Project hooks', 'execution');
    const claudeSettingsPath = path.join(claudeDir, 'settings.json');
    if (existsSync(claudeSettingsPath)) pushItem(items, workingDirectory, 'project-hooks', claudeSettingsPath, 'Legacy project settings', 'execution');

    const mcpPath = path.join(codeAgentDir, 'mcp.json');
    if (existsSync(mcpPath)) pushItem(items, workingDirectory, 'project-mcp', mcpPath, 'Project MCP servers', 'mcp');
    const localMcpPath = path.join(codeAgentDir, 'mcp.local.json');
    if (existsSync(localMcpPath)) pushItem(items, workingDirectory, 'project-mcp-local', localMcpPath, 'Local project MCP servers', 'mcp');

    const agentsDir = path.join(codeAgentDir, 'agents');
    if (hasDirectoryEntriesSync(agentsDir, (entry) => entry.isFile() && entry.name.endsWith('.md'))) {
      pushItem(items, workingDirectory, 'project-agents', agentsDir, 'Project agents', 'agent');
    }

    for (const skillsDir of [path.join(codeAgentDir, 'skills'), path.join(claudeDir, 'skills')]) {
      if (hasDirectoryEntriesSync(skillsDir, (entry) => entry.isDirectory())) {
        pushItem(items, workingDirectory, 'project-skills', skillsDir, 'Project skills', 'skill');
      }
    }

    const skillPrefsPath = path.join(codeAgentDir, 'skill-preferences.json');
    if (existsSync(skillPrefsPath)) pushItem(items, workingDirectory, 'project-skill-preferences', skillPrefsPath, 'Project skill preferences', 'preference');

    const commandsDir = path.join(codeAgentDir, 'commands');
    if (hasDirectoryEntriesSync(commandsDir, (entry) => entry.isFile() && entry.name.endsWith('.md') && !entry.name.startsWith('.'))) {
      pushItem(items, workingDirectory, 'project-commands', commandsDir, 'Project prompt commands', 'prompt');
    }

    const profilePath = path.join(codeAgentDir, 'PROFILE.md');
    if (existsSync(profilePath)) pushItem(items, workingDirectory, 'project-profile', profilePath, 'Project profile prompt', 'prompt');

    for (const filePath of findAgentInstructionFilesSync(workingDirectory)) {
      pushItem(items, workingDirectory, 'agent-instructions', filePath, 'Project agent instructions', 'prompt');
    }

    const policyPath = path.join(workingDirectory, POLICY_FILENAME);
    if (existsSync(policyPath)) pushItem(items, workingDirectory, 'project-policy', policyPath, 'Project security policy', 'policy');

    for (const fileName of ['capabilities.json', 'rules.json', 'settings.json']) {
      const filePath = path.join(codeAgentDir, fileName);
      if (existsSync(filePath)) pushItem(items, workingDirectory, 'other-project-config', filePath, 'Other project configuration', 'diagnostic', false);
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
  if (!singleton) singleton = new FolderTrustService();
  return singleton;
}

function getTestDefaultProjectConfigTrust(): boolean | undefined {
  if (process.env.VITEST !== 'true' && process.env.NODE_ENV !== 'test') return undefined;
  const value = process.env.CODE_AGENT_TEST_DEFAULT_FOLDER_TRUST;
  if (value === 'trusted') return true;
  if (value === 'blocked' || value === 'untrusted') return false;
  return undefined;
}

export function resetFolderTrustServiceForTest(): void {
  if (singleton) singleton.close();
  singleton = null;
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

export async function isProjectConfigTrusted(workingDirectory: string, kind?: DangerousConfigKind): Promise<boolean> {
  const testDefault = getTestDefaultProjectConfigTrust();
  if (testDefault !== undefined) return testDefault;

  try {
    const evaluation = await evaluateFolderTrust(workingDirectory);
    if (evaluation.state === 'trusted') return true;
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
  const testDefault = getTestDefaultProjectConfigTrust();
  if (testDefault !== undefined) return testDefault;

  try {
    const evaluation = evaluateFolderTrustSync(workingDirectory);
    if (evaluation.state === 'trusted') return true;
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
