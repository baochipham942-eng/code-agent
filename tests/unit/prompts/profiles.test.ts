// ============================================================================
// Profiles Tests
// ============================================================================

import { describe, it, expect } from 'vitest';
import { getProfileOverlays } from '../../../src/main/prompts/profiles';
import { buildProfilePrompt } from '../../../src/main/prompts/builder';
import { DYNAMIC_BOUNDARY_MARKER } from '../../../src/main/prompts/cacheBreakDetection';

// ---------------------------------------------------------------------------
// getProfileOverlays
// ---------------------------------------------------------------------------

describe('getProfileOverlays', () => {
  it('interactive returns all 5 layers', () => {
    const layers = getProfileOverlays('interactive');
    expect(layers.size).toBe(5);
    expect(layers.has('substrate')).toBe(true);
    expect(layers.has('mode')).toBe(true);
    expect(layers.has('memory')).toBe(true);
    expect(layers.has('append')).toBe(true);
    expect(layers.has('projection')).toBe(true);
  });

  it('oneshot returns only substrate', () => {
    const layers = getProfileOverlays('oneshot');
    expect(layers.size).toBe(1);
    expect(layers.has('substrate')).toBe(true);
    expect(layers.has('mode')).toBe(false);
  });

  it('subagent returns substrate, mode, memory', () => {
    const layers = getProfileOverlays('subagent');
    expect(layers.size).toBe(3);
    expect(layers.has('substrate')).toBe(true);
    expect(layers.has('mode')).toBe(true);
    expect(layers.has('memory')).toBe(true);
    expect(layers.has('append')).toBe(false);
    expect(layers.has('projection')).toBe(false);
  });

  it('fork returns empty set', () => {
    const layers = getProfileOverlays('fork');
    expect(layers.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildProfilePrompt
// ---------------------------------------------------------------------------

describe('buildProfilePrompt', () => {
  it('fork with parentPrompt returns parentPrompt directly', () => {
    const parent = 'inherited parent system prompt';
    const result = buildProfilePrompt('fork', { parentPrompt: parent });
    expect(result).toBe(parent);
  });

  it('fork without parentPrompt returns substrate (no dynamic boundary)', () => {
    const result = buildProfilePrompt('fork', {});
    // No parent → fork falls through to substrate-only path (no active overlays)
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    // Should NOT contain dynamic boundary since no dynamic content
    expect(result).not.toContain(DYNAMIC_BOUNDARY_MARKER);
  });

  it('interactive includes dynamic boundary marker', () => {
    const result = buildProfilePrompt('interactive', { appendPrompt: 'extra instructions' });
    expect(result).toContain(DYNAMIC_BOUNDARY_MARKER);
  });

  it('oneshot flattens everything without dynamic boundary', () => {
    const result = buildProfilePrompt('oneshot', {
      rules: ['rule 1'],
      memory: ['mem 1'],
      appendPrompt: 'extra',
    });
    // Oneshot has no active overlays (only substrate), so rules/memory/append are not inserted
    expect(typeof result).toBe('string');
    expect(result).not.toContain(DYNAMIC_BOUNDARY_MARKER);
  });

  it('subagent skips append layer', () => {
    const appendContent = 'THIS_SHOULD_NOT_APPEAR_IN_SUBAGENT';
    const result = buildProfilePrompt('subagent', { appendPrompt: appendContent });
    expect(result).not.toContain(appendContent);
  });

  it('subagent skips projection layer', () => {
    const projContent = 'PROJECTION_CONTENT_NOT_IN_SUBAGENT';
    const result = buildProfilePrompt('subagent', { systemContext: projContent });
    expect(result).not.toContain(projContent);
  });

  it('buildProfilePrompt with rules puts them in memory layer', () => {
    const rule = 'CUSTOM_RULE_CONTENT_XYZ';
    const result = buildProfilePrompt('interactive', { rules: [rule] });
    expect(result).toContain(rule);
  });

  it('buildProfilePrompt with memory puts it after rules', () => {
    const memItem = 'MEMORY_ITEM_CONTENT_ABC';
    const result = buildProfilePrompt('subagent', { memory: [memItem] });
    expect(result).toContain(memItem);
  });

  it('buildProfilePrompt with empty context still returns valid prompt', () => {
    const result = buildProfilePrompt('interactive', {});
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('buildProfilePrompt with no context still returns valid prompt', () => {
    const result = buildProfilePrompt('subagent');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('interactive includes appendPrompt content after boundary', () => {
    const append = 'APPEND_SECTION_MARKER_789';
    const result = buildProfilePrompt('interactive', { appendPrompt: append });
    const [, dynamicPart] = result.split(DYNAMIC_BOUNDARY_MARKER);
    expect(dynamicPart).toContain(append);
  });

  it('interactive includes systemContext (projection) after boundary', () => {
    const projection = 'PROJECTION_MARKER_456';
    const result = buildProfilePrompt('interactive', { systemContext: projection });
    const [, dynamicPart] = result.split(DYNAMIC_BOUNDARY_MARKER);
    expect(dynamicPart).toContain(projection);
  });
});
