import { describe, expect, it } from 'vitest';
import {
  deserializeDesignDoc,
  emptyDesignDoc,
  normalizeDesignDoc,
  serializeDesignDoc,
  type DesignDoc,
} from '../../../src/renderer/components/design/designDocTypes';

describe('designDocTypes', () => {
  it('creates an empty document for a medium', () => {
    expect(emptyDesignDoc('slides')).toMatchObject({
      version: 1,
      id: 'design-doc-slides',
      medium: 'slides',
      pages: [],
      tokens: {},
    });
  });

  it('normalizes structured design doc fields and drops invalid children', () => {
    const doc = normalizeDesignDoc({
      id: 'doc-1',
      title: 'Checkout',
      medium: 'web',
      tokens: {
        colors: { primary: '#0066ff', bad: 123 },
        spacing: { md: 16, bad: 'x' },
      },
      selections: [
        { id: 'sel-1', layerIds: ['layer-1', ''], canvasNodeIds: ['node-1'], note: 'hero' },
        { id: 'bad', layerIds: [] },
      ],
      provenance: [{ id: 'p1', source: 'ai', prompt: 'make ui', model: 'wanx', createdAt: 1 }],
      pages: [
        {
          id: 'page-1',
          medium: 'web',
          frames: [
            {
              id: 'frame-1',
              bounds: { x: 0, y: 0, width: 1440, height: 900 },
              layers: [
                {
                  id: 'layer-1',
                  kind: 'text',
                  text: 'Pay now',
                  bounds: { x: 10, y: 20, width: 100, height: 32 },
                  children: [{ id: 'bad-child', kind: 'unknown' }],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(doc.tokens.colors).toEqual({ primary: '#0066ff' });
    expect(doc.tokens.spacing).toEqual({ md: 16 });
    expect(doc.selections).toEqual([{ id: 'sel-1', layerIds: ['layer-1'], canvasNodeIds: ['node-1'], note: 'hero' }]);
    expect(doc.provenance[0]).toMatchObject({ id: 'p1', source: 'ai', model: 'wanx' });
    expect(doc.pages[0].frames[0].layers[0]).toMatchObject({ id: 'layer-1', kind: 'text', text: 'Pay now' });
    expect(doc.pages[0].frames[0].layers[0].children).toBeUndefined();
  });

  it('serializes through the same normalization boundary', () => {
    const doc: DesignDoc = {
      version: 1,
      id: 'doc-1',
      medium: 'infographic',
      pages: [],
      tokens: {},
      selections: [],
      provenance: [],
    };
    expect(deserializeDesignDoc(serializeDesignDoc(doc))).toEqual(doc);
  });

  it('bad json falls back to an empty web doc', () => {
    expect(deserializeDesignDoc('{bad')).toEqual(emptyDesignDoc());
  });
});
