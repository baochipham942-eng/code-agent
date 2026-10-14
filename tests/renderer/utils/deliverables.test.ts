import { describe, expect, it } from 'vitest';
import type { Message, WorkspacePreviewItem } from '../../../src/shared/contract';
import {
  applyPublishInfoToDeliverableCard,
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
      { kind: 'publish-version', label: 'publish-version', path: '/repo/out/hero.png', title: 'hero.png' },
      { kind: 'share-link', label: 'share-link', path: '/repo/out/hero.png', title: 'hero.png', disabled: true, reason: 'publish-first' },
      { kind: 'reveal-file', label: 'reveal-file', path: '/repo/out/hero.png' },
      { kind: 'copy-reference', label: 'copy-reference', value: '/repo/out/hero.png' },
      expect.objectContaining({
        kind: 'archive-to-library',
        path: '/repo/out/hero.png',
        title: 'hero.png',
      }),
      expect.objectContaining({
        kind: 'export-bundle',
        label: 'export-bundle',
        files: [
          {
            path: '/repo/out/hero.png',
            source: 'latest-published',
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
        role: 'deliverable' as const,
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
      { kind: 'publish-version', label: 'publish-version', path: '/repo/out/diagram.png', title: 'diagram.png' },
      { kind: 'share-link', label: 'share-link', path: '/repo/out/diagram.png', title: 'diagram.png', disabled: true, reason: 'publish-first' },
      { kind: 'reveal-file', label: 'reveal-file', path: '/repo/out/diagram.png' },
      { kind: 'copy-reference', label: 'copy-reference', value: '/repo/out/diagram.png' },
      expect.objectContaining({
        kind: 'archive-to-library',
        path: '/repo/out/diagram.png',
      }),
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

  it('keeps only the latest turn card for repeated previewable paths', () => {
    const cards = buildTurnArtifactDeliverableCards([
      {
        kind: 'file',
        role: 'deliverable',
        label: 'diagram draft.png',
        ownerKind: 'tool',
        ownerLabel: 'designer · Write draft',
        path: '/repo/out/diagram.png',
        sourceNodeId: 'node-1',
      },
      {
        kind: 'file',
        role: 'deliverable',
        label: 'diagram revision.png',
        ownerKind: 'tool',
        ownerLabel: 'designer · Write revision',
        path: '/repo/out/diagram.png',
        sourceNodeId: 'node-2',
      },
      {
        kind: 'file',
        role: 'deliverable',
        label: 'diagram final.png',
        ownerKind: 'tool',
        ownerLabel: 'designer · Write final',
        path: '/repo/out/diagram.png',
        sourceNodeId: 'node-3',
      },
    ]);

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      title: 'diagram final.png',
      sourceLabel: 'designer · Write final',
      openTarget: { kind: 'file-preview', path: '/repo/out/diagram.png' },
      contextPack: { sourceOfTruth: ['/repo/out/diagram.png', 'trace-node:node-3'] },
    });
  });

  it('uses card ids for no-path turn cards', () => {
    const cards = buildTurnArtifactDeliverableCards([
      {
        kind: 'link',
        role: 'deliverable',
        label: 'docs-a',
        ownerKind: 'tool',
        ownerLabel: 'Open first',
        url: 'https://example.test/shared',
        sourceNodeId: 'url-node-a',
      },
      {
        kind: 'link',
        role: 'deliverable',
        label: 'docs-b',
        ownerKind: 'tool',
        ownerLabel: 'Open distinct',
        url: 'https://example.test/shared',
        sourceNodeId: 'url-node-b',
      },
      {
        kind: 'link',
        role: 'deliverable',
        label: 'docs-a',
        ownerKind: 'tool',
        ownerLabel: 'Open latest',
        url: 'https://example.test/shared',
        sourceNodeId: 'url-node-a',
      },
    ]);

    expect(cards).toHaveLength(2);
    expect(cards.map((card) => card.title)).toEqual(['docs-b', 'docs-a']);
    expect(cards.map((card) => card.sourceLabel)).toEqual(['Open distinct', 'Open latest']);
    expect(cards.every((card) => card.openTarget.kind === 'external')).toBe(true);
  });

  it('keeps different previewable paths in input order', () => {
    const cards = buildTurnArtifactDeliverableCards([
      {
        kind: 'file',
        role: 'deliverable',
        label: 'first.png',
        ownerKind: 'tool',
        ownerLabel: 'Write first',
        path: '/repo/out/first.png',
        sourceNodeId: 'node-1',
      },
      {
        kind: 'file',
        role: 'deliverable',
        label: 'second.png',
        ownerKind: 'tool',
        ownerLabel: 'Write second',
        path: '/repo/out/second.png',
        sourceNodeId: 'node-2',
      },
      {
        kind: 'file',
        role: 'deliverable',
        label: 'third.png',
        ownerKind: 'tool',
        ownerLabel: 'Write third',
        path: '/repo/out/third.png',
        sourceNodeId: 'node-3',
      },
    ]);

    expect(cards.map((card) => card.openTarget)).toEqual([
      { kind: 'file-preview', path: '/repo/out/first.png' },
      { kind: 'file-preview', path: '/repo/out/second.png' },
      { kind: 'file-preview', path: '/repo/out/third.png' },
    ]);
  });

  it('projects draft, published, and published-dirty states and enables sharing from the published snapshot', () => {
    const [draft] = buildTurnArtifactDeliverableCards([{
      kind: 'file',
      role: 'deliverable',
      label: 'report.md',
      ownerKind: 'tool',
      ownerLabel: 'Write',
      path: '/repo/report.md',
    }]);
    expect(draft.publishState).toEqual({ kind: 'draft' });

    const version = {
      version: 2,
      publishedAt: 200,
      snapshotPath: '/repo/.doc-snapshots/report.published-v2.md',
    };
    const published = applyPublishInfoToDeliverableCard(draft, {
      publishState: { kind: 'published', version: 2, publishedAt: 200 },
      publishedVersions: [version],
    });
    const dirty = applyPublishInfoToDeliverableCard(draft, {
      publishState: { kind: 'published-dirty', version: 2, publishedAt: 200 },
      publishedVersions: [version],
    });

    expect(published.publishState.kind).toBe('published');
    expect(dirty.publishState.kind).toBe('published-dirty');
    expect(published.secondaryActions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'share-link',
        disabled: false,
        reason: undefined,
      }),
      expect.objectContaining({
        kind: 'export-bundle',
        disabled: false,
        sourceVersion: 2,
        files: [expect.objectContaining({ source: 'latest-published' })],
      }),
    ]));
  });

  it('turn 文件有任一工具账本实证字段即已验证，无实证仍未验证', () => {
    const cards = buildTurnArtifactDeliverableCards([
      {
        kind: 'file',
        role: 'deliverable',
        label: 'hash.md',
        ownerKind: 'tool',
        ownerLabel: 'Write',
        path: '/repo/hash.md',
        fileMetadata: { sha256: 'a'.repeat(64) },
      },
      {
        kind: 'file',
        role: 'deliverable',
        label: 'size.md',
        ownerKind: 'tool',
        ownerLabel: 'Write',
        path: '/repo/size.md',
        fileMetadata: { sizeBytes: 0 },
      },
      {
        kind: 'file',
        role: 'deliverable',
        label: 'mime.md',
        ownerKind: 'tool',
        ownerLabel: 'Write',
        path: '/repo/mime.md',
        fileMetadata: { mimeType: 'text/markdown' },
      },
      {
        kind: 'file',
        role: 'deliverable',
        label: 'path-only.md',
        ownerKind: 'tool',
        ownerLabel: 'Write',
        path: '/repo/path-only.md',
      },
    ]);

    expect(cards.map((card) => card.status)).toEqual(['verified', 'verified', 'verified', 'unverified']);
    expect(cards[0].evidencePack.refs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'file_metadata', status: 'pass' }),
    ]));
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
      id: 'pending-media:assistant-image:tool-image-pending',
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

  it('summarizes batch prompts and the renamed output path', () => {
    const message: Message = {
      id: 'assistant-image-batch',
      role: 'assistant',
      content: '',
      timestamp: 301,
      toolCalls: [{
        id: 'tool-image-batch',
        name: 'image_generate',
        arguments: {
          prompt: ['first prompt', 'second prompt'],
          output_file_path: 'images/result.png',
        },
      }],
    };
    const [card] = buildPendingImageDeliverableCards(message);
    expect(card.contextPack.goal).toBe('first prompt +1 more');
    expect(card.contextPack.constraints).toContain('output_file_path:images/result.png');
  });

  it('projects running video/music generation with output_file_path and legacy output_path', () => {
    const message: Message = {
      id: 'assistant-media',
      role: 'assistant',
      content: '',
      timestamp: 302,
      toolCalls: [
        {
          id: 'tool-video-pending',
          name: 'video_generate',
          arguments: { prompt: '海面日出延时', output_file_path: 'videos/clip.mp4' },
        },
        {
          id: 'tool-music-pending',
          name: 'music_generate',
          arguments: { prompt: '一段轻快的配乐', output_path: 'music/legacy-track.mp3' },
        },
        {
          id: 'tool-video-done',
          name: 'video_generate',
          arguments: { prompt: 'already done' },
          result: { toolCallId: 'tool-video-done', success: true },
        },
      ],
    };

    const cards = buildPendingImageDeliverableCards(message);
    expect(cards).toHaveLength(2);
    const [videoCard, musicCard] = cards;
    expect(videoCard).toMatchObject({
      kind: 'video',
      title: 'Generating video',
      sourceLabel: 'video_generate',
      openTarget: { kind: 'none', reason: 'Video is still generating' },
    });
    expect(videoCard.contextPack.constraints).toContain('output_file_path:videos/clip.mp4');
    expect(videoCard.contextPack.deliverableType).toBe('Video');
    expect(musicCard).toMatchObject({
      kind: 'audio',
      title: 'Generating music',
      sourceLabel: 'music_generate',
      openTarget: { kind: 'none', reason: 'Music is still generating' },
    });
    // 旧 output_path 的历史请求按原参数名入账
    expect(musicCard.contextPack.constraints).toContain('output_path:music/legacy-track.mp3');
  });
});

// N-DELIVERABLE-WORKDIR-DEFAULT：无文件夹新会话的产物落在按会话目录（任务_MMDD_<标题>）。
// 交付卡「打开文件夹」（reveal-file → workspace.showItemInFolder）取的是交付物自身的绝对
// 路径（deliverables.ts 不另设目录来源），文件由工具按 cwd（= 按会话目录）写出，所以
// reveal 落点天然在该目录内——这里钉死这条取径契约，防止将来改成别的目录来源。
describe('deliverable card open-folder source for per-session task folders', () => {
  it('keeps reveal-file and file-preview anchored to the artifact path inside the session work folder', () => {
    const sessionFolder = '/tmp/verify-home/Neo/任务_1011_季度总结';
    const artifactPath = `${sessionFolder}/report.md`;

    const workspaceItem: WorkspacePreviewItem = {
      id: `file:${artifactPath}`,
      kind: 'document',
      title: '季度总结',
      subtitle: 'write',
      status: 'ready',
      createdAt: 300,
      source: { kind: 'tool', label: 'write', toolCallId: 'tool-report' },
      file: { path: artifactPath, name: 'report.md', mimeType: 'text/markdown', size: 42 },
    };

    const card = buildDeliverableCardFromWorkspaceItem(workspaceItem);
    expect(card.openTarget).toMatchObject({ kind: 'file-preview', path: artifactPath });
    const reveal = card.secondaryActions?.find((action) => action.kind === 'reveal-file');
    expect(reveal).toMatchObject({ kind: 'reveal-file', path: artifactPath });
    expect(reveal?.path.startsWith(`${sessionFolder}/`)).toBe(true);

    const turnCards = buildTurnArtifactDeliverableCards([
      {
        kind: 'file',
        role: 'deliverable',
        sourceNodeId: 'turn-node-1',
        label: '季度总结图表',
        ownerKind: 'tool',
        ownerLabel: 'write · Created',
        path: `${sessionFolder}/chart.png`,
      },
    ]);
    expect(turnCards[0]?.openTarget).toMatchObject({ kind: 'file-preview', path: `${sessionFolder}/chart.png` });
    expect(turnCards[0]?.secondaryActions?.find((action) => action.kind === 'reveal-file'))
      .toMatchObject({ kind: 'reveal-file', path: `${sessionFolder}/chart.png` });
  });
});
