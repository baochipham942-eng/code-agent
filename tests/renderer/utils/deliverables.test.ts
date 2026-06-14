import { describe, expect, it } from 'vitest';
import type { Message, WorkspacePreviewItem } from '../../../src/shared/contract';
import {
  buildDeliverableCardFromWorkspaceItem,
  buildMessageArtifactDeliverableCards,
  buildPendingImageDeliverableCards,
  buildTurnArtifactDeliverableCards,
} from '../../../src/renderer/utils/deliverables';

describe('deliverable card projection', () => {
  it('projects assistant message artifacts into workspace-preview deliverable cards', () => {
    const message: Message = {
      id: 'assistant-1',
      role: 'assistant',
      content: '',
      timestamp: 100,
      artifacts: [
        {
          id: 'artifact-ui',
          type: 'generative_ui',
          title: 'Landing Draft',
          content: '<section>Draft</section>',
          version: 3,
          parentId: 'artifact-ui-v2',
        },
      ],
    };

    const cards = buildMessageArtifactDeliverableCards(message);

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      id: 'message:assistant-1:artifact-ui',
      title: 'Landing Draft',
      status: 'unverified',
      openTarget: {
        kind: 'workspace-preview',
        itemId: 'artifact:assistant-1:artifact-ui',
      },
      contextPack: {
        deliverableType: 'HTML',
        sourceOfTruth: ['message:assistant-1'],
        priorArtifacts: ['artifact:artifact-ui-v2'],
      },
      revisionContext: {
        artifactId: 'artifact-ui',
        version: 3,
        parentId: 'artifact-ui-v2',
      },
    });
    expect(cards[0]?.evidencePack.refs.map((ref) => ref.kind)).toEqual([
      'artifact_version',
      'preview_route',
    ]);
  });

  it('builds evidence and context from workspace preview file metadata', () => {
    const item: WorkspacePreviewItem = {
      id: 'file:/repo/out/hero.png',
      kind: 'web_snapshot',
      title: 'Hero preview',
      subtitle: 'image_generate',
      status: 'ready',
      createdAt: 200,
      source: {
        kind: 'tool',
        label: 'image_generate',
        toolCallId: 'tool-1',
      },
      file: {
        path: '/repo/out/hero.png',
        name: 'hero.png',
        mimeType: 'image/png',
        size: 1200,
        sha256: 'a'.repeat(64),
      },
    };

    const card = buildDeliverableCardFromWorkspaceItem(item);

    expect(card).toMatchObject({
      title: 'Hero preview',
      status: 'verified',
      openTarget: {
        kind: 'file-preview',
        path: '/repo/out/hero.png',
      },
      contextPack: {
        deliverableType: 'Image',
        sourceOfTruth: ['/repo/out/hero.png', 'tool-call:tool-1'],
      },
    });
    expect(card.evidencePack.refs.some((ref) => ref.kind === 'file_metadata' && ref.status === 'pass')).toBe(true);
    expect(card.contract.requiredChecks).toContain('File hash is recorded');
    expect(card.secondaryActions).toEqual([
      { kind: 'reveal-file', label: 'Reveal', path: '/repo/out/hero.png' },
      { kind: 'copy-reference', label: 'Copy path', value: '/repo/out/hero.png' },
      expect.objectContaining({
        kind: 'export-bundle',
        label: 'Export bundle',
        files: [
          {
            path: '/repo/out/hero.png',
            name: 'hero.png',
            role: 'primary',
            mimeType: 'image/png',
            sha256: 'a'.repeat(64),
          },
        ],
        manifest: expect.objectContaining({
          source: 'deliverable-card',
          itemId: 'file:/repo/out/hero.png',
          title: 'Hero preview',
        }),
      }),
    ]);
  });

  it('surfaces workspace quality issues and revision lineage on deliverable cards', () => {
    const item: WorkspacePreviewItem = {
      id: 'file:/repo/app/index.html',
      kind: 'generic_html',
      title: 'index.html',
      subtitle: 'Write',
      status: 'ready',
      createdAt: 220,
      source: {
        kind: 'tool',
        label: 'Write',
        toolCallId: 'tool-html',
      },
      file: {
        path: '/repo/app/index.html',
        name: 'index.html',
        mimeType: 'text/html',
        sha256: 'd'.repeat(64),
      },
      revision: {
        artifactId: 'artifact-html-v3',
        version: 3,
        parentId: 'artifact-html-v2',
        parentRef: 'artifact:artifact-html-v2',
        filePath: '/repo/app/index.html',
        sha256: 'd'.repeat(64),
        sourceTool: 'Write',
        changeSummary: 'Reworked hero layout',
      },
      quality: {
        status: 'failed',
        summary: 'Mobile smoke failed',
        issueCount: 1,
        blocking: true,
      },
    };

    const card = buildDeliverableCardFromWorkspaceItem(item);

    expect(card).toMatchObject({
      status: 'failed',
      tone: 'error',
      quality: {
        status: 'failed',
        summary: 'Mobile smoke failed',
        issueCount: 1,
        blocking: true,
      },
      contextPack: {
        priorArtifacts: ['artifact:artifact-html-v2'],
      },
      revisionContext: {
        artifactId: 'artifact-html-v3',
        version: 3,
        parentId: 'artifact-html-v2',
        filePath: '/repo/app/index.html',
        sha256: 'd'.repeat(64),
        sourceTool: 'Write',
      },
    });
    expect(card.evidencePack.refs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'artifact_issue',
          status: 'fail',
          summary: 'Mobile smoke failed',
        }),
      ]),
    );
    expect(card.description).toContain('v3');
  });

  it('treats image turn outputs as previewable file deliverables', () => {
    const cards = buildTurnArtifactDeliverableCards([
      {
        kind: 'file',
        label: 'diagram.png',
        ownerKind: 'tool',
        ownerLabel: 'designer · Write',
        path: '/repo/out/diagram.png',
        sourceNodeId: 'node-1',
      },
    ]);

    expect(cards[0]).toMatchObject({
      kind: 'image',
      status: 'unverified',
      openTarget: {
        kind: 'file-preview',
        path: '/repo/out/diagram.png',
      },
      contextPack: {
        deliverableType: 'Image',
        sourceOfTruth: ['/repo/out/diagram.png', 'trace-node:node-1'],
      },
    });
    expect(cards[0].secondaryActions).toEqual([
      { kind: 'reveal-file', label: 'Reveal', path: '/repo/out/diagram.png' },
      { kind: 'copy-reference', label: 'Copy path', value: '/repo/out/diagram.png' },
      expect.objectContaining({
        kind: 'export-bundle',
        files: [
          expect.objectContaining({
            path: '/repo/out/diagram.png',
            role: 'primary',
          }),
        ],
      }),
    ]);
  });

  it('projects running image generation as a session-scoped pending deliverable', () => {
    const message: Message = {
      id: 'assistant-image',
      role: 'assistant',
      content: '',
      timestamp: 300,
      toolCalls: [
        {
          id: 'tool-image-pending',
          name: 'image_generate',
          arguments: {
            prompt: 'A crisp product render on a white background',
            aspect_ratio: '16:9',
          },
        },
        {
          id: 'tool-image-done',
          name: 'image_generate',
          arguments: { prompt: 'already done' },
          result: {
            toolCallId: 'tool-image-done',
            success: true,
            metadata: {
              imagePath: '/repo/out/done.png',
            },
          },
        },
      ],
    };

    const cards = buildPendingImageDeliverableCards(message);

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      id: 'pending-image:assistant-image:tool-image-pending',
      kind: 'image',
      title: 'Generating image',
      sourceLabel: 'image_generate',
      openTarget: {
        kind: 'none',
        reason: 'Image is still generating',
      },
      contextPack: {
        goal: 'A crisp product render on a white background',
        deliverableType: 'Image',
        sourceOfTruth: ['message:assistant-image', 'tool-call:tool-image-pending'],
        constraints: ['aspect_ratio:16:9'],
        acceptance: [
          'Generated image is persisted as a file artifact',
          'Inline base64 is omitted after persistence',
        ],
      },
      evidencePack: {
        status: 'unverified',
      },
    });
  });
});
