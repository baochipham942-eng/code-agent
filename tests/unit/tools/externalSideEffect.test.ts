import { describe, expect, it } from 'vitest';
import { isExternalSideEffectTool } from '../../../src/host/tools/externalSideEffect';

describe('isExternalSideEffectTool (EXTERNAL 风险类判据)', () => {
  it('flags native send tools (mail_send) as external', () => {
    expect(isExternalSideEffectTool('mail_send')).toBe(true);
  });

  it('does NOT flag webSearch/webFetch (network read, not external)', () => {
    // 首版命门：绝不误伤只读联网，否则无人值守审批风暴。
    expect(isExternalSideEffectTool('WebSearch')).toBe(false);
    expect(isExternalSideEffectTool('web_search')).toBe(false);
    expect(isExternalSideEffectTool('WebFetch')).toBe(false);
    expect(isExternalSideEffectTool('web_fetch')).toBe(false);
  });

  it('flags IM MCP send tools (lark/feishu/slack/telegram + message/im/send)', () => {
    expect(isExternalSideEffectTool('mcp__lark__im_v1_message_create')).toBe(true);
    expect(isExternalSideEffectTool('mcp__feishu__send_message')).toBe(true);
    expect(isExternalSideEffectTool('mcp__slack__chat_postMessage')).toBe(true);
    expect(isExternalSideEffectTool('mcp__telegram__sendMessage')).toBe(true);
    // 历史遗留单下划线命名
    expect(isExternalSideEffectTool('mcp_lark_im_message_create')).toBe(true);
  });

  it('does NOT flag IM MCP read tools (list/get, no send keyword)', () => {
    expect(isExternalSideEffectTool('mcp__lark__im_chat_list')).toBe(false);
    expect(isExternalSideEffectTool('mcp__slack__users_info')).toBe(false);
  });

  it('does NOT flag non-messaging MCP servers even with send-like names', () => {
    // 白名单外的 server 不判 external（不信第三方自报）。
    expect(isExternalSideEffectTool('mcp__github__create_pull_request')).toBe(false);
    expect(isExternalSideEffectTool('mcp__notion__send_page')).toBe(false);
  });

  it('does NOT flag plain file writes / reads / bash', () => {
    expect(isExternalSideEffectTool('Write')).toBe(false);
    expect(isExternalSideEffectTool('write_file')).toBe(false);
    expect(isExternalSideEffectTool('Read')).toBe(false);
    expect(isExternalSideEffectTool('Bash')).toBe(false);
  });

  it('does NOT flag mail_draft (saved locally, not sent — v1 conservative omission)', () => {
    expect(isExternalSideEffectTool('mail_draft')).toBe(false);
  });
});
