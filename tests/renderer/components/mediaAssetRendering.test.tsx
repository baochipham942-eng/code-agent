import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TurnCard } from '../../../src/renderer/components/features/chat/TurnCard';
import { AttachmentDisplay } from '../../../src/renderer/components/features/chat/MessageBubble/AttachmentPreview';
import { FileArtifactCard } from '../../../src/renderer/components/features/chat/MessageBubble/FileArtifactCard';
import {
  getMediaAssetAvailableActions,
  getRenderableMediaSrc,
  MediaAssetLightbox,
} from '../../../src/renderer/components/features/chat/MessageBubble/MediaAssetControls';
import { MessageContent } from '../../../src/renderer/components/features/chat/MessageBubble/MessageContent';
import { ToolDetails } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/ToolDetails';
import { useSessionStore } from '../../../src/renderer/stores/sessionStore';
import { LARGE_INLINE_MEDIA_BYTES } from '../../../src/shared/utils/sessionMediaAssets';

describe('media asset rendering', () => {
  it('renders markdown images with media lightbox/action affordances', () => {
    const html = renderToStaticMarkup(
      <MessageContent
        content="![diagram](/repo/assets/diagram.png)"
        isUser={false}
        messageId="assistant-1"
      />,
    );

    expect(html).toContain('放大查看');
    expect(html).toContain('复制引用');
    expect(html).toContain('diagram');
    expect(html).toContain('file:///repo/assets/diagram.png');
  });

  it('renders attachment images with unified media ownership and actions', () => {
    const html = renderToStaticMarkup(
      <AttachmentDisplay
        mediaContext={{ sessionId: 'session-attachment', messageId: 'user-1' }}
        attachments={[
          {
            id: 'att-image',
            type: 'image',
            category: 'image',
            name: 'input.png',
            path: '/repo/input.png',
            mimeType: 'image/png',
            size: 128,
          },
        ]}
      />,
    );

    expect(html).toContain('file:///repo/input.png');
    expect(html).toContain('data-media-session-id="session-attachment"');
    expect(html).toContain('data-media-message-id="user-1"');
    expect(html).toContain('放大查看');
    expect(html).toContain('保存');
  });

  it('skips oversized inline attachment previews instead of rendering the data URL', () => {
    const payload = 'a'.repeat(Math.ceil((LARGE_INLINE_MEDIA_BYTES + 1) * 4 / 3));
    const dataUrl = `data:image/png;base64,${payload}`;
    const html = renderToStaticMarkup(
      <AttachmentDisplay
        mediaContext={{ sessionId: 'session-attachment', messageId: 'user-1' }}
        attachments={[
          {
            id: 'att-large',
            type: 'image',
            category: 'image',
            name: 'large.png',
            data: dataUrl,
            thumbnail: dataUrl,
            mimeType: 'image/png',
            size: LARGE_INLINE_MEDIA_BYTES + 1,
          },
        ]}
      />,
    );

    expect(html).toContain('图片过大，已跳过内联预览');
    expect(html).toContain('data-media-session-id="session-attachment"');
    expect(html).not.toContain(dataUrl);
  });

  it('skips oversized inline video attachment previews instead of rendering the data URL', () => {
    const payload = 'a'.repeat(Math.ceil((LARGE_INLINE_MEDIA_BYTES + 1) * 4 / 3));
    const dataUrl = `data:video/mp4;base64,${payload}`;
    const html = renderToStaticMarkup(
      <AttachmentDisplay
        mediaContext={{ sessionId: 'session-attachment', messageId: 'user-1' }}
        attachments={[
          {
            id: 'att-video-large',
            type: 'file',
            category: 'video',
            name: 'large-video.mp4',
            data: dataUrl,
            thumbnail: dataUrl,
            mimeType: 'video/mp4',
            size: LARGE_INLINE_MEDIA_BYTES + 1,
          },
        ]}
      />,
    );

    expect(html).toContain('视频过大，已跳过内联预览');
    expect(html).toContain('data-media-session-id="session-attachment"');
    expect(html).not.toContain(dataUrl);
  });

  it('renders generated tool images through media asset controls with tool ownership', () => {
    const html = renderToStaticMarkup(
      <ToolDetails
        mediaContext={{ sessionId: 'session-tool', turnId: 'turn-tool', messageId: 'assistant-1' }}
        toolCall={{
          id: 'tool-image',
          name: 'image_generate',
          arguments: {},
          result: {
            toolCallId: 'tool-image',
            success: true,
            metadata: {
              imagePath: '/repo/generated.png',
              originalPrompt: 'draw product shot',
              model: 'flux',
            },
          },
        }}
      />,
    );

    expect(html).toContain('file:///repo/generated.png');
    expect(html).toContain('data-media-session-id="session-tool"');
    expect(html).toContain('data-media-turn-id="turn-tool"');
    expect(html).toContain('data-media-message-id="assistant-1"');
    expect(html).toContain('data-media-tool-call-id="tool-image"');
    expect(html).toContain('保存');
  });

  it('promotes generic media tool outputs instead of showing raw result payload', () => {
    const html = renderToStaticMarkup(
      <ToolDetails
        mediaContext={{ sessionId: 'session-tool', messageId: 'assistant-1' }}
        toolCall={{
          id: 'tool-process',
          name: 'image_process',
          arguments: {},
          result: {
            toolCallId: 'tool-process',
            success: true,
            output: 'raw media result payload',
            metadata: {
              inputPath: '/repo/source.png',
              outputPath: '/repo/source_resized.png',
            },
          },
        }}
      />,
    );

    expect(html).toContain('source_resized.png');
    expect(html).toContain('工具结果');
    expect(html).toContain('data-media-tool-call-id="tool-process"');
    expect(html).not.toContain('raw media result payload');
  });

  it('renders pending media tool placeholders with ownership context', () => {
    const html = renderToStaticMarkup(
      <ToolDetails
        mediaContext={{ sessionId: 'session-tool', turnId: 'turn-pending', messageId: 'assistant-1' }}
        toolCall={{
          id: 'tool-pending-image',
          name: 'image_generate',
          arguments: {},
        }}
      />,
    );

    expect(html).toContain('媒体生成中');
    expect(html).toContain('data-media-session-id="session-tool"');
    expect(html).toContain('data-media-turn-id="turn-pending"');
    expect(html).toContain('data-media-tool-call-id="tool-pending-image"');
  });

  it('renders failed media tool placeholders with the error visible', () => {
    const html = renderToStaticMarkup(
      <ToolDetails
        mediaContext={{ sessionId: 'session-tool', turnId: 'turn-failed', messageId: 'assistant-1' }}
        toolCall={{
          id: 'tool-failed-video',
          name: 'video_generate',
          arguments: {},
          result: {
            toolCallId: 'tool-failed-video',
            success: false,
            error: 'quota exceeded',
          },
        }}
      />,
    );

    expect(html).toContain('媒体生成失败');
    expect(html).toContain('quota exceeded');
    expect(html).toContain('data-media-session-id="session-tool"');
    expect(html).toContain('data-media-turn-id="turn-failed"');
    expect(html).toContain('data-media-tool-call-id="tool-failed-video"');
  });

  it('promotes artifact image files out of the also-modified text list', () => {
    const html = renderToStaticMarkup(
      <FileArtifactCard
        items={[
          {
            kind: 'file',
            label: 'render.png',
            ownerKind: 'tool',
            ownerLabel: 'image_process',
            path: '/repo/render.png',
            sourceNodeId: 'tool-node',
          },
        ]}
      />,
    );

    expect(html).toContain('render.png');
    expect(html).toContain('file:///repo/render.png');
    expect(html).toContain('放大查看');
    expect(html).toContain('保存');
    expect(html).not.toContain('Also modified');
  });

  it('shows source and parent relationship in the media lightbox header', () => {
    const html = renderToStaticMarkup(
      <MediaAssetLightbox
        asset={{
          assetId: 'media-1',
          source: 'artifact',
          role: 'output',
          sources: [
            { source: 'tool_result', role: 'output', toolCallId: 'tool-1' },
            { source: 'artifact', role: 'output', artifactId: 'artifact-1' },
          ],
          kind: 'image',
          state: 'ready',
          path: '/repo/edited.png',
          filename: 'edited.png',
          parentAssetIds: ['path:/repo/input-a.png', 'path:/repo/input-b.png'],
        }}
        onClose={() => {}}
      />,
    );

    expect(html).toContain('工具结果 / 输出文件');
    expect(html).toContain('来源');
    expect(html).toContain('工具 tool-1');
    expect(html).toContain('输出 artifact-1');
    expect(html).toContain('2 个输入素材');
    expect(html).toContain('输入素材');
    expect(html).toContain('input-a.png');
    expect(html).toContain('input-b.png');
  });

  it('does not place oversized inline base64 media into the render src', () => {
    const payload = 'a'.repeat(Math.ceil((LARGE_INLINE_MEDIA_BYTES + 1) * 4 / 3));
    const dataUrl = `data:image/png;base64,${payload}`;
    const asset = {
      assetId: 'large-inline',
      source: 'markdown' as const,
      role: 'output' as const,
      sources: [{ source: 'markdown' as const, role: 'output' as const, messageId: 'assistant-1' }],
      kind: 'image' as const,
      state: 'ready' as const,
      dataUrl,
      filename: 'large-inline.png',
      inlineBytes: LARGE_INLINE_MEDIA_BYTES + 1,
      largeInlineData: true,
    };

    expect(getRenderableMediaSrc(asset)).toBe('');

    const html = renderToStaticMarkup(
      <MediaAssetLightbox
        asset={asset}
        onClose={() => {}}
      />,
    );

    expect(html).toContain('内联媒体过大，已跳过预览');
    expect(html).not.toContain(dataUrl);
  });

  it('keeps media actions consistent for local, remote, and oversized inline assets', () => {
    expect(getMediaAssetAvailableActions({
      assetId: 'local-image',
      source: 'artifact',
      role: 'output',
      sources: [{ source: 'artifact', role: 'output' }],
      kind: 'image',
      state: 'ready',
      path: '/repo/local.png',
    }, { hasLightbox: true })).toEqual(['copy', 'lightbox', 'open', 'save', 'reveal']);

    expect(getMediaAssetAvailableActions({
      assetId: 'remote-image',
      source: 'markdown',
      role: 'output',
      sources: [{ source: 'markdown', role: 'output' }],
      kind: 'image',
      state: 'ready',
      url: 'https://example.com/remote.png',
    }, { hasLightbox: true })).toEqual(['copy', 'lightbox', 'open', 'save']);

    expect(getMediaAssetAvailableActions({
      assetId: 'large-inline',
      source: 'markdown',
      role: 'output',
      sources: [{ source: 'markdown', role: 'output' }],
      kind: 'image',
      state: 'ready',
      dataUrl: `data:image/png;base64,${'a'.repeat(Math.ceil((LARGE_INLINE_MEDIA_BYTES + 1) * 4 / 3))}`,
      inlineBytes: LARGE_INLINE_MEDIA_BYTES + 1,
      largeInlineData: true,
    }, { hasLightbox: true })).toEqual(['copy']);
  });

  it('uses the projection session id for artifact media instead of the current session', () => {
    useSessionStore.setState({ currentSessionId: 'current-session' });

    const html = renderToStaticMarkup(
      <TurnCard
        sessionId="projection-session"
        showSeparator={false}
        turn={{
          turnNumber: 1,
          turnId: 'turn-old',
          status: 'completed',
          startTime: 100,
          endTime: 120,
          nodes: [
            {
              id: 'turn-old-artifact-ownership',
              type: 'turn_timeline',
              content: '',
              timestamp: 120,
              turnTimeline: {
                id: 'turn-old-artifact-ownership',
                kind: 'artifact_ownership',
                timestamp: 120,
                tone: 'success',
                artifactOwnership: [
                  {
                    kind: 'file',
                    label: 'old-render.png',
                    ownerKind: 'tool',
                    ownerLabel: 'image_process',
                    path: '/repo/old-render.png',
                    sourceNodeId: 'tool-old',
                  },
                ],
              },
            },
          ],
        }}
      />,
    );

    expect(html).toContain('old-render.png');
    expect(html).toContain('data-media-session-id="projection-session"');
    expect(html).not.toContain('data-media-session-id="current-session"');
  });
});
