import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('Surface Execution native PiP controls', () => {
  it('registers owner-scoped interactive controls from the PiP webview to the renderer', () => {
    const rust = fs.readFileSync(path.join(root, 'src-tauri/src/pip.rs'), 'utf8');
    const main = fs.readFileSync(path.join(root, 'src-tauri/src/main.rs'), 'utf8');
    const html = fs.readFileSync(path.join(root, 'public/pip.html'), 'utf8');

    expect(main).toContain('pip_control, pip_controls');
    expect(main).toMatch(/pip_controls,\s+pip_control,/);
    expect(rust).toContain('window.label() != PIP_LABEL');
    expect(rust).toContain('surface-pip-control');
    expect(rust).toContain('set_ignore_cursor_events(false)');
    expect(html).toContain("internals.invoke('pip_control'");
    expect(html).toContain('window.__setControls');
    expect(html).toContain('Take over');
  });
});
