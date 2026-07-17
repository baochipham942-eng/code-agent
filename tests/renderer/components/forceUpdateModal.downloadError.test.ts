import { describe, expect, it } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';
import {
  classifyDownloadErrorKind,
  toDownloadErrorPresentation,
} from '../../../src/renderer/components/ForceUpdateModal';

// ForceUpdateModal 下载失败此前把 event.data.error / err.message 原样 setError 展示。
// 现在按错误类分流：网络类/磁盘类走对应人话，分不出类别走通用兜底 + 原文进
// detail（渲染层挂 tooltip，不裸露成主文案）。

describe('classifyDownloadErrorKind — 错误类分流', () => {
  it('网络类样本报错 → network', () => {
    const samples = [
      'Error: connect ETIMEDOUT 1.2.3.4:443',
      'getaddrinfo ENOTFOUND download.example.com',
      'network error while fetching resource',
      'socket hang up: ECONNRESET',
      'proxy connection failed',
      'request timed out after 30000ms',
    ];
    for (const sample of samples) {
      expect(classifyDownloadErrorKind(sample), sample).toBe('network');
    }
  });

  it('磁盘类样本报错 → disk', () => {
    const samples = [
      'ENOSPC: no space left on device',
      'EACCES: permission denied, open \'/Applications/x.dmg\'',
      'EPERM: operation not permitted',
      'disk full, cannot write installer',
    ];
    for (const sample of samples) {
      expect(classifyDownloadErrorKind(sample), sample).toBe('disk');
    }
  });

  it('无法归类的报错 → unknown', () => {
    expect(classifyDownloadErrorKind('signature verification failed')).toBe('unknown');
    expect(classifyDownloadErrorKind('unexpected server response: 500')).toBe('unknown');
  });
});

describe('toDownloadErrorPresentation — message 走分类人话，detail 只在兜底时装原文', () => {
  it('网络类：message 是网络人话文案，没有 detail（原文不裸露）', () => {
    const result = toDownloadErrorPresentation('connect ETIMEDOUT', zh.notices.update);
    expect(result.message).toBe(zh.notices.update.downloadErrorNetwork);
    expect(result.detail).toBeUndefined();
  });

  it('磁盘类：message 是磁盘人话文案，没有 detail', () => {
    const result = toDownloadErrorPresentation('ENOSPC: no space left on device', zh.notices.update);
    expect(result.message).toBe(zh.notices.update.downloadErrorDisk);
    expect(result.detail).toBeUndefined();
  });

  it('无法归类：message 走通用兜底，原文进 detail 供 tooltip 使用', () => {
    const raw = 'signature verification failed: checksum mismatch';
    const result = toDownloadErrorPresentation(raw, zh.notices.update);
    expect(result.message).toBe(zh.notices.update.unknownError);
    expect(result.detail).toBe(raw);
  });

  it('en 语言下同样分流（不建第二套判定逻辑，只是取的 n 不同）', () => {
    const result = toDownloadErrorPresentation('connect ETIMEDOUT', en.notices.update);
    expect(result.message).toBe(en.notices.update.downloadErrorNetwork);
  });
});
