import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CONFIG_DIR_NEW } from '../../shared/constants/configDir';
import { MAX_DEV_SLOT, devSlotDataDirName } from '../../shared/devSlot';

export type SensitiveSandboxPathKind = 'directory' | 'file';

export interface SensitiveSandboxPath {
  kind: SensitiveSandboxPathKind;
  path: string;
}

export interface SensitiveSandboxPathOptions {
  homeDir?: string;
  env?: Partial<Pick<NodeJS.ProcessEnv, 'CODE_AGENT_DATA_DIR'>>;
}

const HOME_SECRET_DIRS = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.docker',
  path.join('.config', 'gh'),
  path.join('.config', 'gcloud'),
];

const HOME_SECRET_FILES = [
  '.netrc',
  '.git-credentials',
  '.npmrc',
  '.pypirc',
  '.env',
];

const HOME_SECRET_FILE_PREFIXES = [
  '.env',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
];

const DATA_DIR_SECRET_FILES = [
  '.secure-key',
  'secure-storage.json',
  '.env',
  'code-agent.db',
];

export function getSensitiveSandboxPaths(
  options: SensitiveSandboxPathOptions = {},
): SensitiveSandboxPath[] {
  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  const env = options.env ?? process.env;
  const entries: SensitiveSandboxPath[] = [];

  for (const relativePath of HOME_SECRET_DIRS) {
    entries.push({ kind: 'directory', path: path.join(homeDir, relativePath) });
  }

  for (const relativePath of HOME_SECRET_FILES) {
    entries.push({ kind: 'file', path: path.join(homeDir, relativePath) });
  }

  for (const fileName of enumerateHomeSecretPrefixMatches(homeDir)) {
    entries.push({ kind: 'file', path: path.join(homeDir, fileName) });
  }

  for (const dataDir of getCandidateDataDirs(homeDir, env)) {
    for (const fileName of DATA_DIR_SECRET_FILES) {
      entries.push({ kind: 'file', path: path.join(dataDir, fileName) });
    }
  }

  return dedupeSensitivePaths(entries);
}

export interface SensitiveCredentialPathOptions {
  homeDir?: string;
  projectRoot?: string;
}

/**
 * Classify credential-bearing read targets from the same source lists used by
 * the OS sandbox. Unlike getSensitiveSandboxPaths(), this check is lexical and
 * does not require the target to exist, so approval cannot depend on timing.
 */
export function isSensitiveCredentialPath(
  candidatePath: string,
  options: SensitiveCredentialPathOptions = {},
): boolean {
  const candidate = path.resolve(candidatePath);
  const homeDir = path.resolve(options.homeDir ?? os.homedir());

  for (const relativePath of HOME_SECRET_DIRS) {
    const secretDir = path.join(homeDir, relativePath);
    if (candidate === secretDir || candidate.startsWith(`${secretDir}${path.sep}`)) return true;
  }

  if (HOME_SECRET_FILES.some((relativePath) => candidate === path.join(homeDir, relativePath))) {
    return true;
  }

  if (
    path.dirname(candidate) === homeDir
    && HOME_SECRET_FILE_PREFIXES.some((prefix) => path.basename(candidate).startsWith(prefix))
  ) {
    return true;
  }

  if (options.projectRoot) {
    const projectRoot = path.resolve(options.projectRoot);
    const relative = path.relative(projectRoot, candidate);
    const isInsideProject = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    const name = path.basename(candidate);
    if (isInsideProject && name.startsWith('.env')) {
      return true;
    }
  }

  return false;
}

export function isPathDeniedBySensitiveSandboxPath(
  candidatePath: string,
  entries: SensitiveSandboxPath[],
): boolean {
  const resolved = path.resolve(candidatePath);
  return entries.some((entry) => {
    const denied = path.resolve(entry.path);
    if (entry.kind === 'file') return resolved === denied;
    return resolved === denied || resolved.startsWith(`${denied}${path.sep}`);
  });
}

interface ProtectedWritePathOptions {
  homeDir?: string;
  projectRoot?: string;
  env?: Partial<Pick<NodeJS.ProcessEnv, 'CODE_AGENT_DATA_DIR'>>;
}

// As-built user-level files under getUserConfigDir() / candidate data dirs.
// Project-level counterparts live on projectRoot (see isProtectedWritePath).
// ponytail: coverage ceiling is the closed as-built default, not a full Neo
// config inventory. Known gaps (same baseline verdict, not a regression):
// project-level `.code-agent/settings.json`, `permissions.json`,
// `hooks/hooks.json`, `mcp.json`; user-level `permissions.json` / `mcp.json`.
const PROTECTED_DATA_DIR_FILES = [
  'policy.toml',
  'session-permission-modes.json',
  'exec-policy.json',
  'hooks.json',
];

function isProtectedSettingsFileName(fileName: string): boolean {
  return fileName.startsWith('settings') && fileName.endsWith('.json');
}

/** path.resolve plus the existing-parent realpath, so /var and /private/var compare equal. */
function pathAliases(input: string): string[] {
  const resolved = path.resolve(input);
  const aliases = new Set<string>([resolved]);
  try {
    aliases.add(fs.realpathSync(resolved));
  } catch {
    try {
      aliases.add(path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved)));
    } catch {
      // keep the lexical form; comparison stays existence-independent
    }
  }
  return [...aliases];
}

interface ProtectedWritePathAnchors {
  key: string;
  dataDirAliases: string[];
  homeAliases: string[];
  projectRootAliases: string[];
}

let protectedWritePathAnchors: ProtectedWritePathAnchors | null = null;

function protectedWriteAnchorKey(
  homeDir: string,
  env: Partial<Pick<NodeJS.ProcessEnv, 'CODE_AGENT_DATA_DIR'>>,
  projectRoot: string | undefined,
): string {
  return `${homeDir}\0${env.CODE_AGENT_DATA_DIR?.trim() ?? ''}\0${projectRoot ?? ''}`;
}

/**
 * Data-dir / home / projectRoot aliases do not depend on the candidate path.
 * Memoize by (home, CODE_AGENT_DATA_DIR, projectRoot) so env-overriding tests
 * still pierce the cache when any of those three change.
 */
function getProtectedWritePathAnchors(
  homeDir: string,
  env: Partial<Pick<NodeJS.ProcessEnv, 'CODE_AGENT_DATA_DIR'>>,
  projectRoot: string | undefined,
): ProtectedWritePathAnchors {
  const key = protectedWriteAnchorKey(homeDir, env, projectRoot);
  if (protectedWritePathAnchors?.key === key) return protectedWritePathAnchors;
  protectedWritePathAnchors = {
    key,
    dataDirAliases: getCandidateDataDirs(homeDir, env).flatMap(pathAliases),
    homeAliases: pathAliases(homeDir),
    projectRootAliases: projectRoot ? pathAliases(projectRoot) : [],
  };
  return protectedWritePathAnchors;
}

/** Test-only: drop the (home, env, projectRoot) alias cache. */
export function resetProtectedWritePathAliasCacheForTest(): void {
  protectedWritePathAnchors = null;
}

/**
 * Writes that would let the agent rewrite the constraints that bind it.
 * Comparison is the same path.resolve / prefix check as
 * isSensitiveCredentialPath / isPathDeniedBySensitiveSandboxPath.
 * The list is a closed default: callers may only tighten, never disable.
 */
export function isProtectedWritePath(
  candidatePath: string,
  options: ProtectedWritePathOptions = {},
): boolean {
  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  const env = options.env ?? process.env;
  const { dataDirAliases, homeAliases, projectRootAliases } = getProtectedWritePathAnchors(
    homeDir,
    env,
    options.projectRoot,
  );
  const candidateAliases = pathAliases(candidatePath);
  const entries: SensitiveSandboxPath[] = [];

  for (const resolvedDataDir of dataDirAliases) {
    for (const fileName of PROTECTED_DATA_DIR_FILES) {
      entries.push({ kind: 'file', path: path.join(resolvedDataDir, fileName) });
    }
    entries.push({ kind: 'directory', path: path.join(resolvedDataDir, 'hooks') });
  }

  for (const projectRoot of projectRootAliases) {
    entries.push({ kind: 'file', path: path.join(projectRoot, '.git', 'config') });
    entries.push({ kind: 'file', path: path.join(projectRoot, '.gitconfig') });
    entries.push({ kind: 'file', path: path.join(projectRoot, '.npmrc') });
    entries.push({ kind: 'file', path: path.join(projectRoot, CONFIG_DIR_NEW, 'exec-policy.json') });
    entries.push({ kind: 'file', path: path.join(projectRoot, 'code-agent-policy.toml') });
  }

  for (const resolvedHome of homeAliases) {
    entries.push({ kind: 'file', path: path.join(resolvedHome, '.gitconfig') });
    entries.push({ kind: 'file', path: path.join(resolvedHome, '.npmrc') });
  }

  const protectedEntries = dedupeSensitivePaths(entries);
  for (const candidate of candidateAliases) {
    for (const resolvedDataDir of dataDirAliases) {
      if (
        path.dirname(candidate) === resolvedDataDir
        && isProtectedSettingsFileName(path.basename(candidate))
      ) {
        return true;
      }
    }
    if (isPathDeniedBySensitiveSandboxPath(candidate, protectedEntries)) return true;
  }
  return false;
}

function enumerateHomeSecretPrefixMatches(homeDir: string): string[] {
  let fileNames: string[];
  try {
    fileNames = fs.readdirSync(homeDir);
  } catch {
    return [];
  }

  return fileNames.filter((fileName) => (
    HOME_SECRET_FILE_PREFIXES.some((prefix) => fileName.startsWith(prefix))
  ));
}

function getCandidateDataDirs(
  homeDir: string,
  env: Partial<Pick<NodeJS.ProcessEnv, 'CODE_AGENT_DATA_DIR'>>,
): string[] {
  const dirs = [
    env.CODE_AGENT_DATA_DIR?.trim() ? path.resolve(env.CODE_AGENT_DATA_DIR.trim()) : undefined,
    path.join(homeDir, CONFIG_DIR_NEW),
    ...Array.from({ length: MAX_DEV_SLOT }, (_, index) => (
      path.join(homeDir, devSlotDataDirName(index + 1))
    )),
  ].filter((dir): dir is string => Boolean(dir));

  return Array.from(new Set(dirs));
}

function dedupeSensitivePaths(entries: SensitiveSandboxPath[]): SensitiveSandboxPath[] {
  const seen = new Set<string>();
  const result: SensitiveSandboxPath[] = [];
  for (const entry of entries) {
    const resolved = path.resolve(entry.path);
    const key = `${entry.kind}:${resolved}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...entry, path: resolved });
  }
  return result;
}
