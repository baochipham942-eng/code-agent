import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const gateScript = resolve('scripts/ci/visual-shotbase-baseline-gate.mjs');
const roots: string[] = [];
const specPath = 'tests/e2e/visual-shotbase.spec.ts';
const snapshotDir = `${specPath}-snapshots`;
const lightBaseline = `${snapshotDir}/dangerous-command-approval-light-chromium-linux.png`;
const darkBaseline = `${snapshotDir}/dangerous-command-approval-dark-chromium-linux.png`;

function write(root: string, relativePath: string, content: string): void {
  const absolutePath = join(root, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'visual-shotbase-baseline-gate-'));
  roots.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Visual Gate Test');
  git(root, 'config', 'user.email', 'visual-gate@example.test');
  write(root, specPath, [
    "import { test, expect } from '@playwright/test';",
    "async function openAppWithTheme(page: any) { await page.goto('/'); }",
    "test('visual', async ({ page }) => {",
    '  await openAppWithTheme(page);',
    "  await expect(page.locator('.h-screen')).toHaveScreenshot('dangerous-command-approval.png');",
    '});',
    '',
  ].join('\n'));
  write(root, lightBaseline, 'linux-light-v1');
  write(root, darkBaseline, 'linux-dark-v1');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'baseline');
  return root;
}

function runGate(root: string, baseRef = 'HEAD') {
  return spawnSync(process.execPath, [
    gateScript,
    '--repo-root',
    root,
    '--base-ref',
    baseRef,
  ], { encoding: 'utf8' });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('visual-shotbase baseline gate', () => {
  it('当前截图契约与 Linux 基线一致时为绿', () => {
    const result = runGate(makeFixture());
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('截图契约与 Linux 基线同步');
  });

  it('改截图前页面状态却不更新基线时给出人话红线', () => {
    const root = makeFixture();
    const spec = join(root, specPath);
    appendFileSync(spec, '\n');
    const source = String(execFileSync('git', ['show', `HEAD:${specPath}`], { cwd: root }));
    writeFileSync(spec, source.replace("await page.goto('/');", "await page.goto('/?panel=expanded');"));

    const result = runGate(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('你改了截图前的页面状态但没重生成基线');
    expect(result.stderr).toContain(lightBaseline);
    expect(result.stderr).toContain(darkBaseline);
  });

  it('两张 Linux 基线随截图契约同步更新时为绿', () => {
    const root = makeFixture();
    const spec = join(root, specPath);
    const source = String(execFileSync('git', ['show', `HEAD:${specPath}`], { cwd: root }));
    writeFileSync(spec, source.replace("await page.goto('/');", "await page.goto('/?panel=expanded');"));
    write(root, lightBaseline, 'linux-light-v2');
    write(root, darkBaseline, 'linux-dark-v2');

    const result = runGate(root);
    expect(result.status, result.stderr).toBe(0);
  });

  it('拒绝拿更早提交改过的基线为后续截图契约变化充数', () => {
    const root = makeFixture();
    const baseRef = git(root, 'rev-parse', 'HEAD');
    write(root, lightBaseline, 'linux-light-v2');
    write(root, darkBaseline, 'linux-dark-v2');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'refresh baselines first');

    const spec = join(root, specPath);
    const source = String(execFileSync('git', ['show', `HEAD:${specPath}`], { cwd: root }));
    writeFileSync(spec, source.replace("await page.goto('/');", "await page.goto('/?panel=expanded');"));
    git(root, 'add', specPath);
    git(root, 'commit', '-qm', 'change visual contract later');

    const result = runGate(root, baseRef);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('你改了截图前的页面状态但没重生成基线');
    expect(result.stderr).toContain(lightBaseline);
    expect(result.stderr).toContain(darkBaseline);
  });

  it('拒绝 -darwin 后缀基线冒充 Linux 产物', () => {
    const root = makeFixture();
    write(
      root,
      `${snapshotDir}/dangerous-command-approval-light-chromium-darwin.png`,
      'macos-image',
    );

    const result = runGate(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('发现 macOS 视觉基线');
    expect(result.stderr).toContain('不要用 -darwin 后缀冒充 Linux 基线');
  });

  it('只改注释与空白时不强制重录 PNG', () => {
    const root = makeFixture();
    const spec = join(root, specPath);
    const source = String(execFileSync('git', ['show', `HEAD:${specPath}`], { cwd: root }));
    writeFileSync(spec, source.replace(
      "async function openAppWithTheme(page: any) { await page.goto('/'); }",
      "// 说明截图主题\nasync function openAppWithTheme(page: any) {\n  await page.goto('/');\n}",
    ));

    const result = runGate(root);
    expect(result.status, result.stderr).toBe(0);
  });
});
