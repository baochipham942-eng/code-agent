import { describe, expect, it } from 'vitest';
import type { MessageAttachment } from '../../../src/shared/contract';
import {
  buildMultimodalContent,
  stripImagesFromMessages,
} from '../../../src/host/agent/messageHandling/converter';

describe('message attachment conversion', () => {
  it('keeps an image analysis path hint when vision content is stripped', () => {
    const attachment: MessageAttachment = {
      id: 'att-1',
      type: 'image',
      category: 'image',
      name: 'screen.png',
      size: 128,
      mimeType: 'image/png',
      data: 'data:image/png;base64,aGVsbG8=',
      path: '/tmp/screen.png',
    };

    const content = buildMultimodalContent('看看这个', [attachment]);
    const imageHint = content.find((part) =>
      part.type === 'text' && part.text?.includes('image_analyze')
    );

    expect(content.some((part) => part.type === 'image')).toBe(true);
    expect(imageHint?.text).toContain('image_analyze');
    expect(imageHint?.text).toContain('/tmp/screen.png');

    const stripped = stripImagesFromMessages([{ role: 'user', content }]);

    expect(JSON.stringify(stripped[0].content)).toContain('image_analyze');
    expect(JSON.stringify(stripped[0].content)).toContain('/tmp/screen.png');
    expect(JSON.stringify(stripped[0].content)).toContain('不要回答“没有收到图片”');
  });

  it('does not ask agents to read a local path for inline appshot images', () => {
    const attachment: MessageAttachment = {
      id: 'appshot-appshot-1',
      type: 'image',
      category: 'image',
      name: 'Finder 截图.png',
      size: 128,
      mimeType: 'image/png',
      data: 'data:image/png;base64,aGVsbG8=',
    };

    const content = buildMultimodalContent(
      '<appshot app="com.apple.finder" name="Finder">Downloads file list</appshot>',
      [attachment],
    );
    const serialized = JSON.stringify(content);

    expect(content.some((part) => part.type === 'image')).toBe(true);
    expect(serialized).toContain('Appshot 截图');
    expect(serialized).toContain('<appshot>');
    expect(serialized).not.toContain('image_analyze');
    expect(serialized).not.toContain('可读取的本地图片路径');
  });

  it('does not expose legacy appshot paths when stripping image content', () => {
    const attachment: MessageAttachment = {
      id: 'appshot-appshot-legacy',
      type: 'image',
      category: 'image',
      name: 'Codex 截图.png',
      size: 128,
      mimeType: 'image/png',
      data: 'data:image/png;base64,aGVsbG8=',
      path: '/Users/linchen/.code-agent/appshots/appshot-legacy.png',
    };

    const content = buildMultimodalContent(
      '<appshot app="com.openai.codex" name="Codex">visible text</appshot>',
      [attachment],
    );
    const stripped = stripImagesFromMessages([{ role: 'user', content }]);
    const serialized = JSON.stringify(stripped);

    expect(serialized).toContain('Appshot 图片已省略');
    expect(serialized).not.toContain('/Users/linchen/.code-agent/appshots/appshot-legacy.png');
    expect(serialized).not.toContain('image_analyze');
    expect(serialized).not.toContain('可读取的本地图片路径');
  });

  it('summarizes persisted audio and video attachments without leaking base64 data into model text', () => {
    const audio: MessageAttachment = {
      id: 'audio-1',
      type: 'file',
      category: 'audio',
      name: 'voice.mp3',
      size: 1024,
      mimeType: 'audio/mpeg',
      data: 'data:audio/mpeg;base64,AAAAAUDIO',
      path: '/tmp/voice.mp3',
    };
    const video: MessageAttachment = {
      id: 'video-1',
      type: 'file',
      category: 'video',
      name: 'clip.mp4',
      size: 2048,
      mimeType: 'video/mp4',
      data: 'data:video/mp4;base64,AAAAVIDEO',
      path: '/tmp/clip.mp4',
    };

    const content = buildMultimodalContent('处理这些媒体', [audio, video]);
    const serialized = JSON.stringify(content);

    expect(serialized).toContain('音频附件: voice.mp3');
    expect(serialized).toContain('视频附件: clip.mp4');
    expect(serialized).toContain('/tmp/voice.mp3');
    expect(serialized).toContain('/tmp/clip.mp4');
    expect(serialized).not.toContain('AAAAAUDIO');
    expect(serialized).not.toContain('AAAAVIDEO');
  });

  it('summarizes presentation and archive attachments without leaking binary data into model text', () => {
    const presentation: MessageAttachment = {
      id: 'ppt-1',
      type: 'file',
      category: 'presentation',
      name: 'plan.pptx',
      size: 4096,
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      data: 'data:application/vnd.openxmlformats-officedocument.presentationml.presentation;base64,AAAAPPTX',
      path: '/tmp/plan.pptx',
      pptJson: JSON.stringify({
        title: 'Launch Plan',
        format: 'pptx',
        slideCount: 2,
        slides: [
          { index: 1, title: 'Launch Plan', textPreview: 'Launch Plan Q1', imageCount: 1 },
          { index: 2, title: 'Risks', textPreview: 'Risks and mitigations', tableCount: 1 },
        ],
      }),
    };
    const archive: MessageAttachment = {
      id: 'zip-1',
      type: 'file',
      category: 'archive',
      name: 'assets.zip',
      size: 2048,
      mimeType: 'application/zip',
      data: 'data:application/zip;base64,AAAAZIP',
      path: '/tmp/assets.zip',
      archiveManifest: {
        format: 'zip',
        supported: true,
        totalFiles: 2,
        totalDirectories: 1,
        totalUncompressedSize: 1234,
        entries: [
          { path: 'images/', isDirectory: true },
          { path: 'images/hero.png', size: 1000 },
        ],
      },
    };

    const content = buildMultimodalContent('看一下这些附件', [presentation, archive]);
    const serialized = JSON.stringify(content);

    expect(serialized).toContain('演示文稿: plan.pptx');
    expect(serialized).toContain('Launch Plan');
    expect(serialized).toContain('压缩包: assets.zip');
    expect(serialized).toContain('images/hero.png');
    expect(serialized).toContain('/tmp/plan.pptx');
    expect(serialized).toContain('/tmp/assets.zip');
    expect(serialized).not.toContain('AAAAPPTX');
    expect(serialized).not.toContain('AAAAZIP');
  });
});
