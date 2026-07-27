import { describe, expect, it } from 'vitest';
import {
  SessionForkPortabilityError,
  buildSessionExportEnvelopeV2,
  planSessionForkImport,
} from '../../../../../src/host/services/sessionFork/portability';
import { OWNER_ID, PROJECT_ID, subtreeDraft } from './fixture';

describe('session fork import planning', () => {
  it('builds a deterministic complete ID remap for a full subtree', () => {
    const envelope = buildSessionExportEnvelopeV2(subtreeDraft());

    const first = planSessionForkImport({
      envelope,
      targetOwnerScopeId: OWNER_ID,
      targetProjectId: PROJECT_ID,
      namespace: 'device-b',
    });
    const second = planSessionForkImport({
      envelope,
      targetOwnerScopeId: OWNER_ID,
      targetProjectId: PROJECT_ID,
      namespace: 'device-b',
    });

    expect(second).toEqual(first);
    expect(Object.keys(first.sessionIdMap).sort()).toEqual(['child', 'root']);
    expect(Object.keys(first.messageIdMap).sort()).toEqual(['a1', 'ca1', 'cu1', 'u1']);
    expect(Object.keys(first.forkIdMap)).toEqual(['fork-1']);
    expect(new Set(Object.values(first.sessionIdMap)).size).toBe(2);
    expect(new Set(Object.values(first.messageIdMap)).size).toBe(4);

    const importedChild = first.envelope.lineage?.nodes.find(
      (node) => node.sessionId === first.sessionIdMap.child,
    );
    expect(importedChild).toMatchObject({
      parentSessionId: first.sessionIdMap.root,
      rootSessionId: first.sessionIdMap.root,
      sourceAnchorMessageId: first.messageIdMap.a1,
      anchorChildMessageId: first.messageIdMap.ca1,
      forkId: first.forkIdMap['fork-1'],
    });
    expect(first.envelope.messages.every((item) => (
      Object.values(first.sessionIdMap).includes(item.sessionId)
    ))).toBe(true);
  });

  it('keeps detached provenance auditable while remapping only the imported child', () => {
    const draft = subtreeDraft();
    const envelope = buildSessionExportEnvelopeV2({
      ...draft,
      mode: 'detached_child',
      rootSessionId: 'child',
      sessions: [draft.sessions[1]],
      lineage: undefined,
      detachedProvenance: {
        sourceRootSessionId: 'root',
        sourceParentSessionId: 'root',
        sourceForkId: 'fork-1',
        sourceAnchorMessageId: 'a1',
        sourceAnchorDigest: `sha256:${'6'.repeat(64)}`,
        sourceDepth: 1,
      },
    });
    const plan = planSessionForkImport({
      envelope,
      targetOwnerScopeId: OWNER_ID,
      targetProjectId: PROJECT_ID,
      namespace: 'device-b',
    });

    expect(plan.sessionIdMap).toEqual({
      child: expect.stringContaining('device-b'),
    });
    expect(plan.envelope.detachedProvenance).toEqual(envelope.detachedProvenance);
    expect(plan.envelope.lineage?.nodes[0]).toMatchObject({
      sessionId: plan.sessionIdMap.child,
      parentSessionId: null,
      rootSessionId: plan.sessionIdMap.child,
    });
  });

  it('blocks implicit owner or project boundary expansion', () => {
    const envelope = buildSessionExportEnvelopeV2(subtreeDraft());

    expect(() => planSessionForkImport({
      envelope,
      targetOwnerScopeId: 'other-owner',
      targetProjectId: PROJECT_ID,
      namespace: 'device-b',
    })).toThrowError(SessionForkPortabilityError);

    expect(() => planSessionForkImport({
      envelope,
      targetOwnerScopeId: OWNER_ID,
      targetProjectId: 'other-project',
      namespace: 'device-b',
    })).toThrow(/PROJECT_SCOPE_MISMATCH/);

    const remapped = planSessionForkImport({
      envelope,
      targetOwnerScopeId: OWNER_ID,
      targetProjectId: 'other-project',
      namespace: 'device-b',
      allowProjectRemap: true,
    });
    expect(remapped.envelope.sessions.every((item) => item.projectId === 'other-project')).toBe(true);
    expect(remapped.envelope.lineage?.nodes.every((item) => item.projectId === 'other-project')).toBe(true);
  });
});
