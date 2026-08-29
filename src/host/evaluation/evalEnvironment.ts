import { constants as fsConstants, existsSync, accessSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { app, getBuildInfo } from '../platform';
import { OS_SANDBOX } from '../../shared/constants/sandbox';
import type { EvalEnvironmentProbe } from '../../shared/contract/evaluation';
import { getSandboxManager } from '../sandbox';

const ENGINE_UNAVAILABLE_MESSAGE = '这个安装包不含评测引擎，请在开发构建里跑';

export interface EvalEnvironmentResult extends EvalEnvironmentProbe {
  repositoryRoot?: string;
  entryPath?: string;
  nodePath: string;
  tsxPath?: string;
  packaged: boolean;
  platform: NodeJS.Platform;
  git: { available: boolean; repository: boolean };
  proxy: Partial<Record<'HTTP_PROXY' | 'HTTPS_PROXY' | 'NO_PROXY' | 'http_proxy' | 'https_proxy' | 'no_proxy', string>>;
  failures: string[];
}

function walkForRepositoryRoot(start: string): string | undefined {
  let current = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(current, 'scripts', 'eval-ci.ts'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function findRepositoryRoot(candidates: Array<string | null | undefined>): string | undefined {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const found = walkForRepositoryRoot(candidate);
    if (found) return found;
  }
  return undefined;
}

export function inspectEvalEnvironment(input: {
  packaged?: boolean;
  cwd?: string;
  platform?: NodeJS.Platform;
  nodePath?: string;
  env?: NodeJS.ProcessEnv;
} = {}): EvalEnvironmentResult {
  const env = input.env ?? process.env;
  const packaged = input.packaged ?? app.isPackaged;
  const platform = input.platform ?? process.platform;
  const nodePath = input.nodePath ?? process.execPath;
  const cwdRoot = findRepositoryRoot([input.cwd ?? process.cwd()]);
  const buildInfo = cwdRoot ? null : getBuildInfo();
  const repositoryRoot = cwdRoot ?? findRepositoryRoot([
    buildInfo?.installedFrom,
    buildInfo?.worktree,
    app.getAppPath(),
  ]);
  const entryPath = repositoryRoot ? path.join(repositoryRoot, 'scripts', 'eval-ci.ts') : undefined;
  const tsxPath = repositoryRoot ? path.join(repositoryRoot, 'node_modules', '.bin', 'tsx') : undefined;
  const failures: string[] = [];

  if (packaged) failures.push('packaged_build');
  if (platform === 'win32') failures.push('unsupported_platform');
  if (!repositoryRoot || !entryPath || !existsSync(entryPath)) failures.push('entry_missing');
  try {
    accessSync(nodePath, fsConstants.X_OK);
  } catch {
    failures.push('node_unavailable');
  }
  if (!tsxPath || !existsSync(tsxPath)) failures.push('tsx_unavailable');

  let gitAvailable = false;
  let gitRepository = false;
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    gitAvailable = true;
  } catch {
    failures.push('git_unavailable');
  }
  if (gitAvailable && repositoryRoot) {
    try {
      execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: repositoryRoot,
        stdio: 'ignore',
      });
      gitRepository = true;
    } catch {
      failures.push('not_git_repository');
    }
  }

  const proxyKeys = [
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  ] as const;
  const proxy: EvalEnvironmentResult['proxy'] = {};
  for (const key of proxyKeys) {
    if (env[key] !== undefined) proxy[key] = env[key];
  }

  const osJailAvailable = getSandboxManager().isAvailable();

  return {
    available: failures.length === 0,
    message: failures.length === 0 ? '评测环境已就绪' : ENGINE_UNAVAILABLE_MESSAGE,
    repositoryRoot,
    entryPath,
    nodePath,
    tsxPath,
    packaged,
    platform,
    osJail: {
      enabled: OS_SANDBOX.ENABLED,
      available: osJailAvailable,
      active: OS_SANDBOX.ENABLED && osJailAvailable,
    },
    git: { available: gitAvailable, repository: gitRepository },
    proxy,
    failures,
  };
}
