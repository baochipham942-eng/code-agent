import { describe, expect, it } from 'vitest';
import {
  buildForkNeighborhoodProjection,
  buildForkSearchDocuments,
  buildForkTreeProjection,
  buildSessionExportEnvelopeV2,
  searchForkDocuments,
} from '../../../../../src/host/services/sessionFork/portability';
import { subtreeDraft } from './fixture';

describe('fork lineage projections', () => {
  it('builds stable search documents without private transcript bodies', () => {
    const envelope = buildSessionExportEnvelopeV2(subtreeDraft());
    const first = buildForkSearchDocuments(envelope);
    const second = buildForkSearchDocuments(structuredClone(envelope));

    expect(second).toEqual(first);
    expect(first.map((item) => item.sessionId)).toEqual(['root', 'child']);
    expect(first[1]).toMatchObject({
      sessionId: 'child',
      parentSessionId: 'root',
      rootSessionId: 'root',
      depth: 1,
      messageCount: 2,
    });
    expect(JSON.stringify(first)).not.toContain('secret body');
    expect(searchForkDocuments(first, 'child').map((item) => item.sessionId)).toEqual(['child']);
  });

  it('projects a deterministic tree and bounded neighborhood', () => {
    const envelope = buildSessionExportEnvelopeV2(subtreeDraft());
    const tree = buildForkTreeProjection(envelope.lineage!);

    expect(tree).toMatchObject({
      sessionId: 'root',
      children: [{
        sessionId: 'child',
        parentSessionId: 'root',
        children: [],
      }],
    });
    expect(buildForkTreeProjection(structuredClone(envelope.lineage!))).toEqual(tree);

    expect(buildForkNeighborhoodProjection(envelope.lineage!, 'child', 1)).toEqual({
      centerSessionId: 'child',
      nodes: [
        expect.objectContaining({ sessionId: 'root', relation: 'ancestor', distance: 1 }),
        expect.objectContaining({ sessionId: 'child', relation: 'self', distance: 0 }),
      ],
      edges: [{ parentSessionId: 'root', childSessionId: 'child' }],
    });
  });
});
