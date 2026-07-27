import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

function readInstallScript(): string {
  return readFileSync(resolve(repoRoot, 'scripts/tauri-install-dev.sh'), 'utf8');
}

function functionBody(script: string, name: string): string {
  const start = script.indexOf(`${name}() {`);
  const nextFunction = script.indexOf('\n}\n\n', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(nextFunction).toBeGreaterThan(start);
  return script.slice(start, nextFunction + 3);
}

describe('dev build-info install gate', () => {
  it('writes build-info after copying the app and before resigning it', () => {
    const script = readInstallScript();
    const copyIndex = script.indexOf('cp -R "$SOURCE_APP" "/Applications/$APP_NAME.app"');
    const writeIndex = script.indexOf('write_build_info', copyIndex);
    const resignIndex = script.indexOf('resign_app_if_possible "/Applications/$APP_NAME.app"', copyIndex);

    expect(copyIndex).toBeGreaterThanOrEqual(0);
    expect(writeIndex).toBeGreaterThan(copyIndex);
    expect(resignIndex).toBeGreaterThan(writeIndex);
    expect(script).toContain('Contents/Resources/build-info.json');
  });

  it('warns before deleting a build from another worktree without blocking install', () => {
    const script = readInstallScript();
    const warningCallIndex = script.indexOf('\nwarn_about_existing_install\n');
    const deleteIndex = script.indexOf('rm -rf "/Applications/$APP_NAME.app"');
    const warningBody = functionBody(script, 'warn_about_existing_install');

    expect(warningCallIndex).toBeGreaterThanOrEqual(0);
    expect(deleteIndex).toBeGreaterThan(warningCallIndex);
    expect(warningBody).toContain('info.worktree !== process.env.CURRENT_PROJECT_ROOT');
    expect(warningBody).toContain('info.branch');
    expect(warningBody).toContain('info.commitShort');
    expect(warningBody).toContain('info.builtAt');
    expect(warningBody).toContain('无 build-info 的旧包');
    expect(warningBody).not.toMatch(/\bexit\b/);
  });
});
