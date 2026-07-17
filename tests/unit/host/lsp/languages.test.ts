// ============================================================================
// languages.ts — extension → LSP language id mapping
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  LANGUAGE_EXTENSIONS,
  getLanguageId,
} from '../../../../src/host/lsp/languages';

describe('getLanguageId / LANGUAGE_EXTENSIONS', () => {
  it('maps common extensions case-insensitively', () => {
    expect(getLanguageId('.ts')).toBe('typescript');
    expect(getLanguageId('.TS')).toBe('typescript');
    expect(getLanguageId('.tsx')).toBe('typescriptreact');
    expect(getLanguageId('.js')).toBe('javascript');
    expect(getLanguageId('.jsx')).toBe('javascriptreact');
    expect(getLanguageId('.py')).toBe('python');
    expect(getLanguageId('.rs')).toBe('rust');
    expect(getLanguageId('.go')).toBe('go');
    expect(getLanguageId('.vue')).toBe('vue');
    expect(getLanguageId('.md')).toBe('markdown');
  });

  it('returns plaintext for unknown or empty extensions', () => {
    expect(getLanguageId('.unknownlang')).toBe('plaintext');
    expect(getLanguageId('')).toBe('plaintext');
    expect(getLanguageId('.')).toBe('plaintext');
  });

  it('keeps multi-extension aliases consistent (cpp / shell / yaml)', () => {
    expect(getLanguageId('.cpp')).toBe('cpp');
    expect(getLanguageId('.cxx')).toBe('cpp');
    expect(getLanguageId('.cc')).toBe('cpp');
    expect(getLanguageId('.sh')).toBe('shellscript');
    expect(getLanguageId('.bash')).toBe('shellscript');
    expect(getLanguageId('.zsh')).toBe('shellscript');
    expect(getLanguageId('.yaml')).toBe('yaml');
    expect(getLanguageId('.yml')).toBe('yaml');
  });

  it('LANGUAGE_EXTENSIONS keys are lowercase dotted extensions', () => {
    for (const key of Object.keys(LANGUAGE_EXTENSIONS)) {
      expect(key.startsWith('.')).toBe(true);
      expect(key).toBe(key.toLowerCase());
    }
  });
});
