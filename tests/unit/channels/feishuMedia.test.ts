import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  materializeFeishuMedia,
  parseFeishuMediaContent,
} from '../../../src/host/channels/feishu/feishuMedia';

let tmpRoot: string | null = null;

afterEach(() => {
  if (tmpRoot) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
  }
});

describe('Feishu media materialization', () => {
  it('parses image, file, and audio content keys', () => {
    expect(parseFeishuMediaContent('image', JSON.stringify({ image_key: 'img_v2' }))).toMatchObject({
      fileKey: 'img_v2',
      fileName: 'image-img_v2.png',
      mimeType: 'image/png',
      resourceType: 'image',
    });
    expect(parseFeishuMediaContent('file', JSON.stringify({ file_key: 'file_v2', file_name: 'a.pdf', file_size: '42' }))).toMatchObject({
      fileKey: 'file_v2',
      fileName: 'a.pdf',
      size: 42,
      resourceType: 'file',
    });
    expect(parseFeishuMediaContent('audio', JSON.stringify({ file_key: 'aud_v2', file_name: 'voice.mp3' }))).toMatchObject({
      fileKey: 'aud_v2',
      fileName: 'voice.mp3',
      mimeType: 'audio/mpeg',
      resourceType: 'audio',
    });
  });

  it('downloads message resources into the channel media cache', async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-media-'));
    const get = vi.fn(async () => ({ data: Buffer.from('PNGDATA') }));
    const client = {
      im: {
        messageResource: { get },
      },
    };

    const result = await materializeFeishuMedia({
      accountId: 'acc-1',
      messageId: 'om_1',
      messageType: 'image',
      content: JSON.stringify({ image_key: 'img_1', file_name: 'photo.png' }),
      client,
      cacheRoot: tmpRoot,
    });

    expect(get).toHaveBeenCalledWith({
      path: {
        message_id: 'om_1',
        file_key: 'img_1',
      },
      params: {
        type: 'image',
      },
    });
    expect(result?.content).toBe('[图片: photo.png]');
    expect(result?.attachments[0]).toMatchObject({
      id: 'img_1',
      type: 'image',
      name: 'photo.png',
      mimeType: 'image/png',
      size: 7,
      platformFileKey: 'img_1',
      metadata: {
        platform: 'feishu',
        accountId: 'acc-1',
        messageId: 'om_1',
        materializationState: 'ready',
      },
    });
    const localPath = result?.attachments[0]?.localPath;
    expect(localPath).toBeTruthy();
    expect(localPath).toContain(path.join(tmpRoot, 'feishu', 'acc-1'));
    expect(fs.readFileSync(localPath!, 'utf8')).toBe('PNGDATA');
  });

  it('keeps Lark media in a separate cache namespace', async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-media-'));
    const client = {
      im: {
        messageResource: {
          get: vi.fn(async () => ({ data: Buffer.from('FILEDATA') })),
        },
      },
    };

    const result = await materializeFeishuMedia({
      accountId: 'global-1',
      platform: 'lark',
      messageId: 'om_lark',
      messageType: 'file',
      content: JSON.stringify({ file_key: 'file_1', file_name: 'brief.pdf' }),
      client,
      cacheRoot: tmpRoot,
    });

    expect(result?.attachments[0]).toMatchObject({
      id: 'file_1',
      name: 'brief.pdf',
      metadata: {
        platform: 'lark',
        accountId: 'global-1',
        materializationState: 'ready',
      },
    });
    expect(result?.attachments[0]?.localPath).toContain(path.join(tmpRoot, 'lark', 'global-1'));
  });

  it('keeps an attachment with failed materialization when no downloader is available', async () => {
    const result = await materializeFeishuMedia({
      accountId: 'acc-1',
      messageId: 'om_2',
      messageType: 'audio',
      content: JSON.stringify({ file_key: 'audio_1', file_name: 'voice.wav' }),
    });

    expect(result?.content).toBe('[语音: voice.wav，下载失败]');
    expect(result?.attachments[0]).toMatchObject({
      id: 'audio_1',
      type: 'audio',
      name: 'voice.wav',
      url: 'audio_1',
      metadata: {
        materializationState: 'failed',
      },
    });
    expect(result?.attachments[0]?.localPath).toBeUndefined();
  });
});
