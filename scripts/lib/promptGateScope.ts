import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

interface PromptChangePaths {
  promptsDir: string;
  toolModulesDir: string;
  builtinPluginsDir: string;
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
    builtinPluginsDir: assignment(source, 'BUILTIN_PLUGINS_DIR'),
    versionFile: assignment(source, 'VERSION_FILE'),
  };
}

export function isPromptInputPath(relativePath: string, scope: PromptChangePaths): boolean {
  return relativePath.startsWith(scope.promptsDir)
    || (
      relativePath.endsWith('.schema.ts')
      && (
        relativePath.startsWith(scope.toolModulesDir)
        || relativePath.startsWith(scope.builtinPluginsDir)
      )
    );
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

export function resolvePromptInputsHash(root: string, scope: PromptChangePaths): string {
  const files: string[] = [];
  const visit = (relativeDirectory: string): void => {
    const absoluteDirectory = path.join(root, relativeDirectory);
    if (!fs.existsSync(absoluteDirectory)) return;
    for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
      const relativePath = path.posix.join(relativeDirectory.replace(/\\/g, '/'), entry.name);
      if (entry.isDirectory()) visit(relativePath);
      else if (entry.isFile() && isPromptInputPath(relativePath, scope)) files.push(relativePath);
    }
  };
  visit(scope.promptsDir);
  visit(scope.toolModulesDir);
  visit(scope.builtinPluginsDir);

  const hash = createHash('sha256');
  for (const relativePath of files.sort()) {
    hash.update(relativePath);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(root, relativePath)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function assertAncestor(root: string, ancestor: string): void {
  git(root, ['merge-base', '--is-ancestor', ancestor, 'HEAD']);
}
