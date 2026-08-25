import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const artifacts = {
  cli: 'dist/cli/index.cjs',
  workerSandbox: 'dist/cli/worker-sandbox.cjs',
  webServer: 'dist/web/webServer.cjs',
  mcp: 'dist/mcp-server.js',
  bridge: 'dist/bridge/code-agent-bridge.cjs',
  testRunner: 'dist/test-runner.cjs',
} as const;

function artifactPath(relativePath: string): string {
  return path.join(repoRoot, relativePath);
}

function firstLine(relativePath: string): string {
  return readFileSync(artifactPath(relativePath), 'utf8').split('\n', 1)[0];
}

function mode(relativePath: string): number {
  return statSync(artifactPath(relativePath)).mode & 0o777;
}

describe.skipIf(process.platform === 'win32')('esbuild artifact executable modes', () => {
  beforeAll(() => {
    for (const relativePath of Object.values(artifacts)) {
      rmSync(artifactPath(relativePath), { force: true });
    }

    execFileSync('npm', ['run', 'build:worker'], { cwd: repoRoot, stdio: 'pipe' });
    execFileSync(
      process.execPath,
      ['node_modules/tsx/dist/cli.mjs', 'esbuild.config.ts', 'cli', 'web', 'mcp', 'bridge', 'test-runner'],
      { cwd: repoRoot, stdio: 'pipe' },
    );
  }, 120_000);

  it('makes the CLI executable because its post-build artifact has a shebang', () => {
    expect(firstLine(artifacts.cli)).toBe('#!/usr/bin/env node');
    expect(mode(artifacts.cli)).toBe(0o755);
  });

  it('keeps worker-sandbox non-executable because it has no shebang', () => {
    expect(firstLine(artifacts.workerSandbox)).not.toMatch(/^#!/);
    expect(mode(artifacts.workerSandbox)).toBe(0o644);
  });

  it('keeps webServer non-executable because it has no shebang', () => {
    expect(firstLine(artifacts.webServer)).not.toMatch(/^#!/);
    expect(mode(artifacts.webServer)).toBe(0o644);
  });

  it('keeps the MCP server executable because its entry has a shebang', () => {
    expect(firstLine(artifacts.mcp)).toBe('#!/usr/bin/env node');
    expect(mode(artifacts.mcp)).toBe(0o755);
  });

  it('keeps bridge non-executable because it has no shebang', () => {
    expect(firstLine(artifacts.bridge)).not.toMatch(/^#!/);
    expect(mode(artifacts.bridge)).toBe(0o644);
  });

  it('keeps test-runner non-executable because it has no shebang', () => {
    expect(firstLine(artifacts.testRunner)).not.toMatch(/^#!/);
    expect(mode(artifacts.testRunner)).toBe(0o644);
  });
});
