import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import {
  buildAttachmentMediaAsset,
  buildArtifactOwnershipMediaAsset,
  buildMarkdownMediaAsset,
  buildToolResultMediaAssets,
  collectSessionMediaAssets,
  estimateDataUrlBytes,
  LARGE_INLINE_MEDIA_BYTES,
} from '../../../src/shared/utils/sessionMediaAssets';

describe('session media assets', () => {
  it('collects attachments, markdown images, and generated tool results with ownership context', () => {
    const messages: Message[] = [
      {
        id: 'user-1',
        role: 'user',
        content: 'edit this image',
        timestamp: 100,
        attachments: [
          {
            id: 'att-1',
            type: 'image',
            category: 'image',
            name: 'input.png',
            size: 128,
            mimeType: 'image/png',
            path: '/repo/input.png',
            thumbnail: 'data:image/png;base64,thumb',
          },
        ],
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Preview: ![hero](https://example.com/hero.png)',
        timestamp: 120,
        toolCalls: [
          {
            id: 'tool-1',
            name: 'image_generate',
            arguments: {},
            result: {
              toolCallId: 'tool-1',
              success: true,
              metadata: {
                imagePath: '/repo/hero.png',
                originalPrompt: 'draw a hero',
                model: 'flux',
              },
            },
          },
        ],
      },
    ];

    const assets = collectSessionMediaAssets({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages,
    });

    expect(assets).toHaveLength(3);
    expect(assets.map((asset) => [asset.kind, asset.role, asset.path || asset.url])).toEqual([
      ['image', 'input', '/repo/input.png'],
      ['image', 'output', 'https://example.com/hero.png'],
      ['image', 'output', '/repo/hero.png'],
    ]);
    expect(assets[0]).toMatchObject({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messageId: 'user-1',
      source: 'attachment',
      sources: [expect.objectContaining({ attachmentId: 'att-1' })],
    });
    expect(assets[2]).toMatchObject({
      toolCallId: 'tool-1',
      prompt: 'draw a hero',
      model: 'flux',
      sources: [expect.objectContaining({ source: 'tool_result', toolCallId: 'tool-1' })],
    });
  });

  it('dedupes the same generated file across tool metadata and artifact metadata', () => {
    const assets = buildToolResultMediaAssets({
      id: 'tool-2',
      name: 'image_generate',
      arguments: {},
      result: {
        toolCallId: 'tool-2',
        success: true,
        metadata: {
          imagePath: '/repo/out.png',
          artifact: {
            artifactId: 'artifact-out',
            kind: 'image',
            sourceTool: 'image_generate',
            name: 'Output image',
            path: '/repo/out.png',
            metadata: {
              originalPrompt: 'draw output',
            },
          },
        },
      },
    }, {
      sessionId: 'session-1',
      turnId: 'turn-1',
      messageId: 'assistant-1',
    });

    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      path: '/repo/out.png',
      role: 'output',
      source: 'tool_result',
    });
    expect(assets[0]?.sources.map((source) => source.source)).toEqual(['tool_result', 'artifact']);
  });

  it('marks large inline base64 media so renderers can avoid treating it as an ordinary lightweight src', () => {
    const payload = 'a'.repeat(Math.ceil((LARGE_INLINE_MEDIA_BYTES + 1) * 4 / 3));
    const dataUrl = `data:image/png;base64,${payload}`;
    const [asset] = collectSessionMediaAssets({
      sessionId: 'session-1',
      message: {
        id: 'assistant-1',
        role: 'assistant',
        content: `![inline](${dataUrl})`,
        timestamp: 100,
      },
    });

    expect(estimateDataUrlBytes(dataUrl)).toBeGreaterThan(LARGE_INLINE_MEDIA_BYTES);
    expect(asset).toMatchObject({
      kind: 'image',
      largeInlineData: true,
    });
  });

  it('does not reuse oversized attachment data URLs as thumbnails', () => {
    const payload = 'a'.repeat(Math.ceil((LARGE_INLINE_MEDIA_BYTES + 1) * 4 / 3));
    const dataUrl = `data:image/png;base64,${payload}`;
    const asset = buildAttachmentMediaAsset({
      id: 'att-large',
      type: 'image',
      category: 'image',
      name: 'large.png',
      mimeType: 'image/png',
      size: LARGE_INLINE_MEDIA_BYTES + 1,
      data: dataUrl,
      thumbnail: dataUrl,
    }, {
      sessionId: 'session-1',
      messageId: 'user-1',
    });

    expect(asset).toMatchObject({
      kind: 'image',
      largeInlineData: true,
      dataUrl,
      thumbnailUrl: undefined,
    });
  });

  it('represents pending and failed media tool calls without leaking tool output into assistant text', () => {
    const [pending] = buildToolResultMediaAssets({
      id: 'tool-pending',
      name: 'image_generate',
      arguments: {},
    }, { sessionId: 'session-1', turnId: 'turn-1' });

    const [failed] = buildToolResultMediaAssets({
      id: 'tool-failed',
      name: 'video_generate',
      arguments: {},
      result: {
        toolCallId: 'tool-failed',
        success: false,
        error: 'quota exceeded',
      },
    }, { sessionId: 'session-1', turnId: 'turn-2' });

    expect(pending).toMatchObject({
      kind: 'image',
      state: 'pending',
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolCallId: 'tool-pending',
    });
    expect(failed).toMatchObject({
      kind: 'video',
      state: 'failed',
      error: 'quota exceeded',
      sessionId: 'session-1',
      turnId: 'turn-2',
      toolCallId: 'tool-failed',
    });
  });

  it('keeps image processing input and output relationship visible', () => {
    const assets = buildToolResultMediaAssets({
      id: 'tool-process',
      name: 'image_process',
      arguments: {},
      result: {
        toolCallId: 'tool-process',
        success: true,
        metadata: {
          inputPath: '/repo/source.png',
          outputPath: '/repo/source_resized.png',
          artifact: {
            artifactId: 'resized',
            kind: 'image',
            sourceTool: 'image_process',
            name: 'source_resized.png',
            path: '/repo/source_resized.png',
            metadata: {
              inputPath: '/repo/source.png',
            },
          },
        },
      },
    }, { sessionId: 'session-1', turnId: 'turn-3' });

    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      path: '/repo/source_resized.png',
      parentAssetIds: ['path:/repo/source.png'],
      sources: [
        expect.objectContaining({ source: 'tool_result' }),
        expect.objectContaining({ source: 'artifact' }),
      ],
    });
  });

  it('keeps multi-image editing inputs attached to the output asset', () => {
    const assets = buildToolResultMediaAssets({
      id: 'tool-edit',
      name: 'image_process',
      arguments: {},
      result: {
        toolCallId: 'tool-edit',
        success: true,
        metadata: {
          inputPaths: ['/repo/input-a.png', '/repo/input-b.png'],
          outputPath: '/repo/composite.png',
        },
      },
    }, { sessionId: 'session-1', turnId: 'turn-4' });

    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      path: '/repo/composite.png',
      parentAssetIds: ['path:/repo/input-a.png', 'path:/repo/input-b.png'],
    });
  });

  it('builds markdown image assets for local paths without wrapping them as base64 data', () => {
    const asset = buildMarkdownMediaAsset('/repo/assets/diagram.png', 'diagram', {
      sessionId: 'session-1',
      turnId: 'turn-1',
      messageId: 'assistant-1',
    });

    expect(asset).toMatchObject({
      kind: 'image',
      source: 'markdown',
      role: 'output',
      path: '/repo/assets/diagram.png',
      dataUrl: undefined,
      filename: 'diagram',
      sessionId: 'session-1',
      turnId: 'turn-1',
      messageId: 'assistant-1',
    });
  });

  it('builds media assets from artifact ownership image files', () => {
    const asset = buildArtifactOwnershipMediaAsset({
      kind: 'file',
      label: 'render.png',
      ownerKind: 'tool',
      ownerLabel: 'image_process',
      path: '/repo/render.png',
      sourceNodeId: 'tool-node',
    }, {
      sessionId: 'session-1',
      turnId: 'turn-2',
    });

    expect(asset).toMatchObject({
      kind: 'image',
      source: 'artifact',
      role: 'output',
      path: '/repo/render.png',
      filename: 'render.png',
      sessionId: 'session-1',
      turnId: 'turn-2',
      sources: [expect.objectContaining({ source: 'artifact', artifactId: 'tool-node' })],
    });
  });
});
