import { describe, expect, it } from 'vitest';
import { canonicalToolName, normalizeToolName, sameToolName } from '../../../src/host/tools/toolNames';

describe('toolNames', () => {
  it('keeps existing bash normalization behavior', () => {
    expect(normalizeToolName('Bash')).toBe('bash');
    expect(sameToolName('Bash', 'bash')).toBe(true);
  });

  it('canonicalizes WebSearch and WebFetch aliases only for proven compatibility names', () => {
    expect(canonicalToolName('WebSearch')).toBe('web_search');
    expect(canonicalToolName('web_search')).toBe('web_search');
    expect(canonicalToolName('WebFetch')).toBe('web_fetch');
    expect(canonicalToolName('web_fetch')).toBe('web_fetch');
  });

  it('preserves unrelated tool names instead of case-folding the whole protocol', () => {
    expect(canonicalToolName('Read')).toBe('Read');
    expect(canonicalToolName('MCPUnified')).toBe('MCPUnified');
    expect(canonicalToolName('custom_Tool')).toBe('custom_Tool');
  });
});
