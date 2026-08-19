import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const document = readFileSync(
  resolve(process.cwd(), 'docs/architecture/intel-x64-support.md'),
  'utf8',
);

describe('Intel x64 支持文档的 VAD 影响面', () => {
  it('写明桌面环境音采集不启动及三条不受影响路径', () => {
    expect(document).toContain('Intel Mac 上整条桌面环境音采集不会启动');
    expect(document).toContain('实时语音通话和 renderer 语音输入不受影响');
    expect(document).toContain('PII 脱敏走 Python');
  });

  it('保留 Intel 真机未验证边界', () => {
    expect(document).toContain('当前开发机为 arm64，Intel 真机验证未完成');
    expect(document).not.toContain('Intel 真机验证通过');
  });

  it.each([
    'VAD 自动静默关闭',
    'x64 用户无自动语音端点检测',
    '不影响脱敏/核心功能',
    'x64 预期不可用，属正常',
    '不算失败',
    '等待本地能力组件准备完成',
  ])('不再包含错误承诺：%s', (phrase) => {
    expect(document).not.toContain(phrase);
  });
});
