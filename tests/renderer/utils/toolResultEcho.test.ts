import { describe, expect, it } from 'vitest';
import { isToolResultEcho } from '../../../src/renderer/utils/toolResultEcho';

describe('isToolResultEcho', () => {
  it('detects a full tool-result array echo', () => {
    const echo = '[{"toolCallId":"call_8e7af69dd2","success":false,"error":"Tool WebFetch was not loaded yet and has now been auto-loaded. Call it again with the correct arguments.","duration":0,"metadata":{"autoLoadedTools":"WebFetch","autoLoaded":true}}]';
    expect(isToolResultEcho(echo)).toBe(true);
  });

  it('detects a streaming (unclosed) echo by its prefix', () => {
    expect(isToolResultEcho('[{"toolCallId":"call_abc","success":fal')).toBe(true);
    expect(isToolResultEcho('  [ { "toolCallId": "call_abc"')).toBe(true);
  });

  it('does not flag normal answers', () => {
    expect(isToolResultEcho('找到了。Codex 最新版的更新内容：...')).toBe(false);
    expect(isToolResultEcho('这是一个数组示例：[1, 2, 3]')).toBe(false);
    expect(isToolResultEcho('')).toBe(false);
    // 提到 toolCallId 但不是工具结果数组 → 不误杀
    expect(isToolResultEcho('每个工具结果都有一个 toolCallId 字段。')).toBe(false);
  });

  it('does not flag a plain JSON array without toolCallId', () => {
    expect(isToolResultEcho('[{"name":"foo","value":1}]')).toBe(false);
  });
});
