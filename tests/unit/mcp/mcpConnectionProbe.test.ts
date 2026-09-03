// MCP 连接态探针：给同步路径（每轮组装 toolScope）读的轻量真相源
import { afterEach, describe, expect, it } from 'vitest';
import {
  getBuiltinInProcessMcpServerIds,
  isMcpServerConnected,
  isMcpStatusUsableForScope,
  setInProcessMcpServerIdsProvider,
  setMcpConnectionProbe,
} from '../../../src/host/mcp/mcpConnectionProbe';

afterEach(() => {
  setMcpConnectionProbe(undefined);
  setInProcessMcpServerIdsProvider(undefined);
});

describe('mcpConnectionProbe', () => {
  it('没人注册探针时一律当没连上——落到调用方「都没连上就不收窄」的安全侧', () => {
    expect(isMcpServerConnected('lark')).toBe(false);
  });

  it('注册后按探针答，各 server 各算各的', () => {
    setMcpConnectionProbe((name) => name === 'lark');

    expect(isMcpServerConnected('lark')).toBe(true);
    expect(isMcpServerConnected('notion')).toBe(false);
  });
});

describe('isMcpStatusUsableForScope（turn scope 收窄的可用判据）', () => {
  it('lazy / connecting / connected 都算可用——lazy 是「装好了、用到就连」，只认 connected 会让收窄在 stdio server 上落空又无声翻转', () => {
    expect(isMcpStatusUsableForScope('connected', true)).toBe(true);
    expect(isMcpStatusUsableForScope('lazy', true)).toBe(true);
    expect(isMcpStatusUsableForScope('connecting', true)).toBe(true);
  });

  it('安全侧：没状态（没装/拼错）/ 已关闭 / error / disconnected 一律不可用 ⇒ 不收窄', () => {
    expect(isMcpStatusUsableForScope(undefined, true)).toBe(false);
    expect(isMcpStatusUsableForScope('lazy', false)).toBe(false);
    expect(isMcpStatusUsableForScope('connected', false)).toBe(false);
    expect(isMcpStatusUsableForScope('error', true)).toBe(false);
    expect(isMcpStatusUsableForScope('disconnected', true)).toBe(false);
  });
});

describe('getBuiltinInProcessMcpServerIds（内置进程内基础设施名单）', () => {
  it('没人注册时答空表——落到「不并」的保守侧，与探针未注册不收窄同向', () => {
    expect(getBuiltinInProcessMcpServerIds()).toEqual([]);
  });

  it('注册后按提供方答', () => {
    setInProcessMcpServerIdsProvider(() => ['memory-kv', 'code-index']);

    expect(getBuiltinInProcessMcpServerIds()).toEqual(['memory-kv', 'code-index']);
  });
});
