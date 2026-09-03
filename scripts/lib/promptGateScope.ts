import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

interface PromptChangePaths {
  promptsDir: string;
  toolModulesDir: string;
  versionFile: string;
}

const SCOPE_FILE = 'scripts/lib/prompt-change-paths.sh';

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function assignment(source: string, name: string): string {
  const match = source.match(new RegExp(`^${name}="([^"]+)"$`, 'm'));
  if (!match?.[1]) throw new Error(`${SCOPE_FILE} is missing ${name}`);
  return match[1];
}

export function loadPromptChangePaths(root: string): PromptChangePaths {
  const source = fs.readFileSync(path.join(root, SCOPE_FILE), 'utf8');
  return {
    promptsDir: assignment(source, 'PROMPTS_DIR'),
    toolModulesDir: assignment(source, 'TOOL_MODULES_DIR'),
    versionFile: assignment(source, 'VERSION_FILE'),
  };
}

export function isPromptInputPath(relativePath: string, scope: PromptChangePaths): boolean {
  // Keep this exactly aligned with check-prompt-version-bump.sh. That hook explicitly records
  // plugins/builtin schemas as an existing blind spot; broadening only this consumer would create
  // the second path policy that N-EVAL-PROMPTGATE forbids.
  return relativePath.startsWith(scope.promptsDir)
    || (relativePath.startsWith(scope.toolModulesDir) && relativePath.endsWith('.schema.ts'));
}

export function changedFiles(root: string, fromRef: string): string[] {
  const committed = git(root, ['diff', '--name-only', `${fromRef}..HEAD`]);
  const working = git(root, ['diff', '--name-only', 'HEAD']);
  const staged = git(root, ['diff', '--cached', '--name-only', 'HEAD']);
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard']);
  return [...new Set(`${committed}\n${working}\n${staged}\n${untracked}`.split(/\r?\n/).filter(Boolean))];
}

export function resolvePromptVersion(root: string, versionFile: string): string {
  const source = fs.readFileSync(path.join(root, versionFile), 'utf8');
  const match = source.match(/export const PROMPT_VERSION\s*=\s*['"]([^'"]+)['"]/);
  if (!match?.[1]) throw new Error(`${versionFile} is missing PROMPT_VERSION`);
  return match[1];
}

export function resolveGitHead(root: string): string {
  return git(root, ['rev-parse', 'HEAD']);
}

export function assertAncestor(root: string, ancestor: string): void {
  git(root, ['merge-base', '--is-ancestor', ancestor, 'HEAD']);
}
