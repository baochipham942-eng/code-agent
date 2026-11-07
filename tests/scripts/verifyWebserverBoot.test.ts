import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const gate = resolve(repoRoot, 'scripts/verify-webserver-boot.mjs');

/**
 * Creates a tmp "repo" the gate can run in: dist/web/webServer.cjs is written
 * later per scenario, and the payload is a bare comment — the static layer only
 * rejects an external `require("…")` of a must-bundle lib, which a comment can
 * never look like. There is no node_modules, so the gate's hide/restore of
 * must-bundle libs is a no-op and the real repo is never touched.
 */
function createBootFixture(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'verify-webserver-boot-'));
  mkdirSync(resolve(root, 'dist/web'), { recursive: true });
  writeFileSync(resolve(root, 'dist/web/webServer.bundle.cjs'), '// stub payload for the boot gate test\n');
  return root;
}

/**
 * Fake webServer.cjs: prints the given lines (stderr for module misses, stdout
 * for the readiness line, matching the real server's streams), then exits after
 * a short delay. The delay lets the gate drain the pipes before the child-exit
 * handler fires, so every scenario settles fast and deterministically.
 */
function fakeServer(stderrLines: string[], stdoutLines: string[] = []): string {
  return [
    ...stdoutLines.map((line) => `process.stdout.write(${JSON.stringify(`${line}\n`)});`),
    ...stderrLines.map((line) => `process.stderr.write(${JSON.stringify(`${line}\n`)});`),
    'setTimeout(() => process.exit(1), 150);',
    '',
  ].join('\n');
}

function writeServer(root: string, source: string): void {
  writeFileSync(resolve(root, 'dist/web/webServer.cjs'), source);
}

function runGate(root: string): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [gate], { cwd: root, encoding: 'utf8', timeout: 60_000 });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

describe('verify-webserver-boot', () => {
  it('is red when the boot output reports a dist/native miss (source mode must not read dist/native)', () => {
    const root = createBootFixture();
    writeServer(root, fakeServer([`Error: Cannot find module '${resolve(root, 'dist/native/better-sqlite3')}'`]));
    const { status, output } = runGate(root);

    expect(status).toBe(1);
    expect(output).toContain('dist/native');
    expect(output).toContain('ADR-086');
  });

  it('is green (warn+pass) for a keytar-style in-package probe miss', () => {
    const root = createBootFixture();
    writeServer(root, fakeServer(["Error: Cannot find module '../build/Release/keytar.node'"]));
    const { status, output } = runGate(root);

    expect(status).toBe(0);
    expect(output).toContain('⚠');
  });

  it('is red when a keytar miss is printed before a dist/native miss (every miss is judged)', () => {
    const root = createBootFixture();
    writeServer(
      root,
      fakeServer([
        "Error: Cannot find module '../build/Release/keytar.node'",
        `Error: Cannot find module '${resolve(root, 'dist/native/better-sqlite3')}'`,
      ]),
    );
    const { status, output } = runGate(root);

    expect(status).toBe(1);
    expect(output).toContain('dist/native');
  });

  it('is green when the boot reaches the HTTP-ready line', () => {
    const root = createBootFixture();
    writeServer(root, fakeServer([], ['[3/3] Starting HTTP server']));
    const { status, output } = runGate(root);

    expect(status).toBe(0);
    expect(output).toContain('runtime boot reached HTTP stage');
  });

  it('is still red for a must-bundle lib missing at boot', () => {
    const root = createBootFixture();
    writeServer(root, fakeServer(["Error: Cannot find module 'pdfkit'"]));
    const { status, output } = runGate(root);

    expect(status).toBe(1);
    expect(output).toContain('must-bundle');
  });
});
