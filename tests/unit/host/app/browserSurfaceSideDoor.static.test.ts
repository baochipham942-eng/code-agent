import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../../../..');

describe('Browser Surface side-door wiring', () => {
  it('keeps browser_navigate free of direct OS/browser automation', () => {
    const source = readFileSync(
      resolve(repoRoot, 'src/host/tools/vision/browserNavigate.ts'),
      'utf8',
    );

    expect(source).toContain("LEGACY_BROWSER_NAVIGATE_ERROR_CODE = 'SURFACE_POLICY_BLOCKED'");
    expect(source).not.toMatch(/child_process|execAsync|osascript|xdotool|System Events/);
  });

  it('rejects legacy LogBridge browser_action before command dispatch', () => {
    const source = readFileSync(
      resolve(repoRoot, 'src/host/app/initBackgroundServices.ts'),
      'utf8',
    );
    const start = source.indexOf('async function setupLogBridge');
    const end = source.indexOf('// P3-A', start);
    const handler = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(handler).toContain("if (command === 'browser_action')");
    expect(handler).toContain('REMOTE_BROWSER_ACTION_REQUIRES_SURFACE_OWNER');
    expect(handler).not.toMatch(/getBrowserService|browserService\.|relayActionFacade|executeRelay/);
  });

  it('does not remove the separate user-initiated openExternal capability', () => {
    const source = readFileSync(resolve(repoRoot, 'src/host/ipc/workspace.ipc.ts'), 'utf8');
    expect(source).toContain("case 'openExternal':");
    expect(source).toContain('await shell.openExternal(payload.url)');
  });
});
