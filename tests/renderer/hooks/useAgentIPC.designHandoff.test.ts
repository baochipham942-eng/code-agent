import { afterEach, describe, expect, it } from 'vitest';
import { withHandoffContext } from '../../../src/renderer/hooks/agent/useAgentIPC';
import { useDesignCanvasStore } from '../../../src/renderer/components/design/designCanvasStore';
import type { CanvasNode, DesignCanvasDoc } from '../../../src/renderer/components/design/designCanvasTypes';
import { DEFAULT_CAMERA } from '../../../src/renderer/components/design/designCanvasTypes';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import type { ConversationEnvelopeContext } from '../../../src/shared/contract/conversationEnvelope';

const node = (id: string, overrides: Partial<CanvasNode> = {}): CanvasNode => ({
  id,
  src: `assets/${id}.png`,
  x: 10,
  y: 20,
  width: 300,
  height: 180,
  createdAt: 1,
  // 展开 Partial<联合类型> 会让 TS 把 kind 挤成 "video" | undefined，判别联合校验过不去；
  // overrides 由调用方负责传出合法组合（如 video 节点须带 kind+durationSec），这里按约定信任。
  ...overrides,
} as CanvasNode);

function loadCanvas(runDir: string, nodes: CanvasNode[]) {
  const doc: DesignCanvasDoc = {
    version: 1,
    nodes,
    camera: { ...DEFAULT_CAMERA },
  };
  useDesignCanvasStore.getState().loadDoc(runDir, doc);
}

function activateDesignSession(sessionId: string): void {
  useSessionStore.setState({ currentSessionId: sessionId });
  useDesignCanvasStore.getState().markSessionDesignActive(sessionId);
  useDesignCanvasStore.getState().claimCanvasForSession(sessionId);
}

describe('useAgentIPC design handoff context', () => {
  afterEach(() => {
    useDesignCanvasStore.setState({
      runDir: null,
      nodes: [],
      connectors: [],
      shapes: [],
      selectedIds: [],
      selectedDiagram: null,
      ownerSessionId: null,
      designActiveSessions: new Set<string>(),
    });
    useSessionStore.setState({ currentSessionId: null });
  });

  it('builds hidden Design->Code handoff from the selected variant and absolute canvas bounds', () => {
    activateDesignSession('design-session');
    loadCanvas('/tmp/design-run', [
      node('reference', { role: 'reference', createdAt: 1 }),
      node('chosen-v1', { chosen: true, label: 'Old chosen variant', createdAt: 2 }),
      node('selected-v2', {
        label: 'Signed off checkout state',
        x: 120,
        y: 64,
        width: 720,
        height: 480,
        createdAt: 3,
      }),
    ]);
    useDesignCanvasStore.getState().setSelected(['selected-v2']);

    const context: ConversationEnvelopeContext = {
      designAcceptanceContract: {
        version: 1,
        intent: 'agent_convergence',
        acceptanceCriteria: [
          { id: 'confirm-state', text: 'Confirm state works after code handoff', priority: 'must' },
        ],
        lockedRegions: [
          {
            id: 'hero-lock',
            nodeId: 'selected-v2',
            preserve: ['layout', 'interaction'],
            lockMode: 'strict',
            regionLock: { epsilon: 8, strict: true },
          },
        ],
        brandRefs: [],
      },
      designCodeHandoff: {
        version: 1,
        mode: 'design_to_code_b',
        codeVisibility: 'hidden',
        userSuccessSignal: 'running_artifact',
        selectedVariants: [
          {
            id: 'selected-v2',
            mediaType: 'image',
            bounds: { x: 0, y: 0, width: 1, height: 1, coordinateSpace: 'canvas_absolute' },
            interactionStates: [
              {
                id: 'confirm-click',
                description: 'Click Confirm and reveal the confirmed state.',
                selector: '#confirm',
                trigger: 'click',
                expectedState: '#state text becomes Confirmed',
              },
            ],
          },
        ],
        previewQa: {
          deterministicPassed: true,
          visionPassed: true,
          repairAttempts: 1,
          finalFindingCount: 0,
        },
      },
    };

    const enriched = withHandoffContext(context);

    expect(enriched?.designCodeHandoff).toMatchObject({
      mode: 'design_to_code_b',
      codeVisibility: 'hidden',
      userSuccessSignal: 'running_artifact',
      selectedVariants: [
        {
          id: 'selected-v2',
          label: 'Signed off checkout state',
          sourcePath: '/tmp/design-run/assets/selected-v2.png',
          bounds: {
            x: 120,
            y: 64,
            width: 720,
            height: 480,
            coordinateSpace: 'canvas_absolute',
          },
          interactionStates: [
            {
              id: 'confirm-click',
              selector: '#confirm',
              expectedState: '#state text becomes Confirmed',
            },
          ],
        },
      ],
      previewQa: {
        deterministicPassed: true,
        visionPassed: true,
        repairAttempts: 1,
        finalFindingCount: 0,
      },
    });
    expect(enriched?.designCodeHandoff?.acceptanceContract?.lockedRegions[0]?.nodeId).toBe('selected-v2');
    expect(enriched?.designCodeHandoff?.canvasSnapshot?.nodes.map((item) => item.id)).toEqual([
      'reference',
      'chosen-v1',
      'selected-v2',
    ]);
  });

  it('injects designCodeHandoff for an agentic design session', () => {
    activateDesignSession('agentic-design-session');
    loadCanvas('/tmp/design-run', [node('selected-v2', { chosen: true })]);

    const context: ConversationEnvelopeContext = {};
    const enriched = withHandoffContext(context);

    expect(enriched).not.toBe(context);
    expect(enriched?.designCodeHandoff?.selectedVariants).toMatchObject([
      { id: 'selected-v2', sourcePath: '/tmp/design-run/assets/selected-v2.png' },
    ]);
  });
});
