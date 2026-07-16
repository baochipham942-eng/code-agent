import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type SensitiveSandboxPathKind = 'directory' | 'file';

export interface SensitiveSandboxPath {
  kind: SensitiveSandboxPathKind;
  path: string;
}

export interface SensitiveSandboxPathOptions {
  homeDir?: string;
  env?: Partial<Pick<NodeJS.ProcessEnv, 'CODE_AGENT_DATA_DIR'>>;
}

const HOME_SECRET_DIRECTORIES = [
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

  for (const relativePath of HOME_SECRET_DIRECTORIES) {
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
    path.join(homeDir, '.code-agent'),
    path.join(homeDir, '.code-agent-dev'),
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
