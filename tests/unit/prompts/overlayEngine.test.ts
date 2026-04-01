// ============================================================================
// Overlay Engine Tests
// ============================================================================

import { describe, it, expect } from 'vitest';
import { applyOverlays, type OverlayConfig } from '../../../src/main/prompts/overlayEngine';

describe('applyOverlays', () => {
  it('returns substrate when no overlays provided', () => {
    const result = applyOverlays('base content', []);
    expect(result).toBe('base content');
  });

  it('returns substrate when all overlays are disabled', () => {
    const overlays: OverlayConfig[] = [
      { layer: 'mode', content: 'mode content', enabled: false },
      { layer: 'memory', content: 'memory content', enabled: false },
    ];
    const result = applyOverlays('base', overlays);
    expect(result).toBe('base');
  });

  it('appends a single enabled overlay with double-newline', () => {
    const overlays: OverlayConfig[] = [
      { layer: 'mode', content: 'mode content', enabled: true },
    ];
    const result = applyOverlays('substrate', overlays);
    expect(result).toBe('substrate\n\nmode content');
  });

  it('appends multiple enabled overlays in order', () => {
    const overlays: OverlayConfig[] = [
      { layer: 'mode', content: 'A', enabled: true },
      { layer: 'memory', content: 'B', enabled: true },
      { layer: 'append', content: 'C', enabled: true },
    ];
    const result = applyOverlays('S', overlays);
    expect(result).toBe('S\n\nA\n\nB\n\nC');
  });

  it('skips disabled overlays but keeps enabled ones in order', () => {
    const overlays: OverlayConfig[] = [
      { layer: 'mode', content: 'mode', enabled: false },
      { layer: 'memory', content: 'memory', enabled: true },
      { layer: 'append', content: 'append', enabled: false },
      { layer: 'projection', content: 'projection', enabled: true },
    ];
    const result = applyOverlays('sub', overlays);
    expect(result).toBe('sub\n\nmemory\n\nprojection');
  });

  it('skips overlays with empty content even if enabled', () => {
    const overlays: OverlayConfig[] = [
      { layer: 'mode', content: '', enabled: true },
      { layer: 'memory', content: 'memory', enabled: true },
    ];
    const result = applyOverlays('sub', overlays);
    expect(result).toBe('sub\n\nmemory');
  });

  it('handles empty substrate with enabled overlays', () => {
    const overlays: OverlayConfig[] = [
      { layer: 'mode', content: 'mode', enabled: true },
      { layer: 'memory', content: 'memory', enabled: true },
    ];
    const result = applyOverlays('', overlays);
    expect(result).toBe('mode\n\nmemory');
  });

  it('returns empty string when substrate is empty and all overlays are disabled', () => {
    const overlays: OverlayConfig[] = [
      { layer: 'mode', content: 'mode', enabled: false },
    ];
    const result = applyOverlays('', overlays);
    expect(result).toBe('');
  });
});
