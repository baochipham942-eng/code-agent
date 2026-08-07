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

  it('does not throw when an image attachment is missing its id (legacy/corrupted history data)', () => {
    // 真机实录 2026-08-07：spawn_task 后台任务继承父会话历史时带上一条缺 id 的
    // 历史图片附件（sanitizeAttachmentForPersistence 透传 attachment.id，脏数据落库后
    // 就是 undefined），buildMultimodalContent 内部对 attachment.id 的裸访问
    // `.startsWith('appshot-')` 直接炸穿整条后台任务执行链路，报出裸 TypeError：
    // "Cannot read properties of undefined (reading 'startsWith')"。
    const attachmentMissingId = {
      type: 'image',
      category: 'image',
      name: '手动导入截图.png',
      size: 128,
      mimeType: 'image/png',
      data: 'data:image/png;base64,aGVsbG8=',
      path: '/tmp/manual-import.png',
      // id 字段缺失 —— 类型标注为必填 string，但运行时数据不保证遵守。
    } as unknown as MessageAttachment;

    expect(() => buildMultimodalContent('看看这个', [attachmentMissingId])).not.toThrow();

    const content = buildMultimodalContent('看看这个', [attachmentMissingId]);
    // 缺 id 不等于 appshot，应按普通图片继续处理（不是 fail-loud 兜底的错误占位）。
    expect(content.some((part) => part.type === 'image')).toBe(true);
    const imageHint = content.find((part) =>
      part.type === 'text' && part.text?.includes('image_analyze')
    );
    expect(imageHint?.text).toContain('image_analyze');
  });

  it('fail-loud: an attachment that still throws mid-processing is skipped with context, not a bare TypeError', () => {
    // category 由 attachment.type 兜底为非法值，触发默认分支的 processDefaultAttachment，
    // 用一个会在字符串插值/字段访问上抛错的 getter 制造真实运行时异常，验证 catch 兜底
    // 记录上下文（附件名/类别）并退化为文本占位，而不是让异常冒穿整条消息构建。
    const attachment: MessageAttachment = {
      id: 'broken-1',
      type: 'file',
      category: 'unknown_category_forcing_default' as unknown as MessageAttachment['category'],
      name: 'broken.bin',
      size: 10,
      mimeType: 'application/octet-stream',
      data: 'data:application/octet-stream;base64,AAAA',
    };
    Object.defineProperty(attachment, 'path', {
      get() {
        throw new Error('simulated corrupted field access');
      },
    });

    let content: ReturnType<typeof buildMultimodalContent> = [];
    expect(() => {
      content = buildMultimodalContent('看看这个', [attachment]);
    }).not.toThrow();
    expect(content.some((part) => part.type === 'text' && part.text?.includes('附件处理失败'))).toBe(true);
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
