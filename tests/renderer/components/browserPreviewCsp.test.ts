import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const EXPECTED_FRAME_SRC = "frame-src 'self' https: http://localhost:* http://127.0.0.1:*";

describe('browser preview frame CSP', () => {
  it.each([
    'src-tauri/tauri.conf.json',
    'src/renderer/index.html',
  ])('%s allows HTTPS pages while retaining local HTTP previews', (relativePath) => {
    const source = readFileSync(path.join(ROOT, relativePath), 'utf8');
    expect(source).toContain(EXPECTED_FRAME_SRC);
  });
});
