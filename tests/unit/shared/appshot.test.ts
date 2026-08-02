import { describe, expect, it } from 'vitest';
import {
  buildAppshotAttachment,
  buildAppshotXml,
  type AppshotCapture,
} from '../../../src/shared/contract/appshot';

function createCapture(overrides: Partial<AppshotCapture> = {}): AppshotCapture {
  return {
    requestId: 'appshot-1',
    appName: 'Finder',
    bundleId: 'com.apple.finder',
    windowTitle: 'Downloads',
    screenshotPath: '/Users/linchen/.code-agent/appshots/appshot-1.png',
    screenshotDataUrl: 'data:image/png;base64,abc123',
    axText: 'Downloads file list',
    textSource: 'ax',
    windowFrame: { x: 10, y: 20, width: 800, height: 600 },
    capturedAtMs: 100,
    ...overrides,
  };
}

describe('appshot contract', () => {
  it('builds an inline image attachment and keeps the local path for bubble rendering', () => {
    const attachment = buildAppshotAttachment(createCapture());

    expect(attachment).toMatchObject({
      type: 'image',
      category: 'image',
      name: 'Finder 截图.png',
      mimeType: 'image/png',
      data: 'data:image/png;base64,abc123',
      thumbnail: 'data:image/png;base64,abc123',
    });
    // path 仅用于气泡本地渲染（媒体管线剥离大图内联数据后的磁盘兜底），不进模型 XML
    expect(attachment).toHaveProperty('path', '/Users/linchen/.code-agent/appshots/appshot-1.png');
  });

  it('does not include the screenshot path in hidden XML context', () => {
    const xml = buildAppshotXml(createCapture());

    expect(xml).toContain('<appshot app="com.apple.finder" name="Finder" captured="');
    expect(xml).toContain('Downloads file list');
    expect(xml).toContain('用户刚刚用快捷键主动截取');
    expect(xml).not.toContain('/Users/linchen/.code-agent/appshots/appshot-1.png');
  });
});
