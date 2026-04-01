// ============================================================================
// Overlay Engine - 5-layer prompt composition
// ============================================================================
// Layers (in order): substrate → mode → memory → append → projection
// Each enabled layer with non-empty content is joined with '\n\n'.
// ============================================================================

export type OverlayLayer = 'substrate' | 'mode' | 'memory' | 'append' | 'projection';

export interface OverlayConfig {
  layer: OverlayLayer;
  content: string;
  enabled: boolean;
}

/**
 * Applies overlay layers to a substrate in order.
 * Each enabled layer's content is appended with double-newline separator.
 * Disabled or empty-content layers are skipped.
 */
export function applyOverlays(substrate: string, overlays: OverlayConfig[]): string {
  const parts: string[] = [];

  if (substrate) {
    parts.push(substrate);
  }

  for (const overlay of overlays) {
    if (overlay.enabled && overlay.content) {
      parts.push(overlay.content);
    }
  }

  return parts.join('\n\n');
}
