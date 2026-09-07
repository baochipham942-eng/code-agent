import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('N-DEADCODE-CLEANUPEVENTS + N-DEADFONT-DECL', () => {
  it('does not keep unused cleanupOldEvents on SessionEventService', () => {
    const src = readFileSync('src/host/session/sessionEventService.ts', 'utf8');
    expect(src).not.toMatch(/cleanupOldEvents/);
  });

  it('does not declare unpackaged Inter / Source Han / JetBrains font families', () => {
    const css = readFileSync('src/renderer/styles/global.css', 'utf8');
    const tailwind = readFileSync('tailwind.config.js', 'utf8');
    for (const haystack of [css, tailwind]) {
      expect(haystack).not.toMatch(/Inter/);
      expect(haystack).not.toMatch(/Source Han/);
      expect(haystack).not.toMatch(/JetBrains/);
    }
  });
});
