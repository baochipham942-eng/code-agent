// MCP 连接态探针：给同步路径（每轮组装 toolScope）读的轻量真相源
import { afterEach, describe, expect, it } from 'vitest';
import { isMcpServerConnected, setMcpConnectionProbe } from '../../../src/host/mcp/mcpConnectionProbe';

afterEach(() => setMcpConnectionProbe(undefined));

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
