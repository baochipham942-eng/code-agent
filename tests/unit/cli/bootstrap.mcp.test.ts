import { describe, it, expect } from 'vitest';
import { cliShouldInitMcp } from '../../../src/cli/bootstrap';

// CLI 模式默认不初始化 MCP（避免拖慢普通 run/exec 启动），
// 仅 computer-use 底座（CUA / argus）显式开启时接入——
// 否则 CODE_AGENT_ENABLE_CUA=1 下 CLI 拿不到 cua-driver 工具，
// 模型只能退回 Bash+AppleScript（前台抢焦点，2026-06-11 真机验证实测）。
describe('cliShouldInitMcp — CLI 按需初始化 MCP', () => {
  it('默认不初始化', () => {
    expect(cliShouldInitMcp({})).toBe(false);
  });

  it('CODE_AGENT_ENABLE_CUA=1 时初始化', () => {
    expect(cliShouldInitMcp({ CODE_AGENT_ENABLE_CUA: '1' })).toBe(true);
  });

  it('CODE_AGENT_ENABLE_ARGUS_MCP=1 时初始化（旧底座回退路径）', () => {
    expect(cliShouldInitMcp({ CODE_AGENT_ENABLE_ARGUS_MCP: '1' })).toBe(true);
  });

  it('值不是 1 时不初始化', () => {
    expect(cliShouldInitMcp({ CODE_AGENT_ENABLE_CUA: 'true' })).toBe(false);
  });
});
