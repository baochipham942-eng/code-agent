import { describe, expect, it } from 'vitest';
import { isExternalSideEffectTool, extractStandingGrantTarget } from '../../../src/host/tools/externalSideEffect';

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

describe('extractStandingGrantTarget (B4 授权 target 提取)', () => {
  it('mail_send: 归一化 to 收件人集合（去空/去重/排序）为精确串', () => {
    expect(extractStandingGrantTarget('mail_send', { to: ['b@x.com', 'a@x.com'] })).toBe('a@x.com,b@x.com');
    // 去重 + 去空白 + 顶层字符串（逗号分隔）也归一
    expect(extractStandingGrantTarget('mail_send', { to: ['a@x.com', ' a@x.com ', ''] })).toBe('a@x.com');
    expect(extractStandingGrantTarget('mail_send', { to: 'a@x.com, b@x.com' })).toBe('a@x.com,b@x.com');
  });

  it('mail_send: target 涵盖 to ∪ cc ∪ bcc（所有实际收件人，一个都不漏）', () => {
    // 三个字段全并进 key，去重排序
    expect(extractStandingGrantTarget('mail_send', {
      to: ['a@x.com'], cc: ['c@x.com'], bcc: ['b@x.com'],
    })).toBe('a@x.com,b@x.com,c@x.com');
    // attachments 不是收件人，不进 key
    expect(extractStandingGrantTarget('mail_send', {
      to: ['a@x.com'], attachments: ['/tmp/secret.pdf'],
    })).toBe('a@x.com');
  });

  it('🔴 mail_send: 加 bcc 不能搭便车——to=[A] 与 to=[A]+bcc=[B] 是不同 target（防抄送外泄提权）', () => {
    const onlyTo = extractStandingGrantTarget('mail_send', { to: ['a@x.com'] });
    const withBcc = extractStandingGrantTarget('mail_send', { to: ['a@x.com'], bcc: ['evil@out.com'] });
    expect(onlyTo).toBe('a@x.com');
    expect(withBcc).toBe('a@x.com,evil@out.com');
    expect(onlyTo).not.toBe(withBcc);
    // cc 同理不能搭便车
    const withCc = extractStandingGrantTarget('mail_send', { to: ['a@x.com'], cc: ['evil@out.com'] });
    expect(withCc).not.toBe(onlyTo);
  });

  it('mail_send: 收件人集合不同 → target 不同（防「换个收件人复用授权」提权）', () => {
    const t1 = extractStandingGrantTarget('mail_send', { to: ['a@x.com'] });
    const t2 = extractStandingGrantTarget('mail_send', { to: ['a@x.com', 'c@x.com'] });
    expect(t1).not.toBe(t2);
  });

  it('mail_send: 无 to → null（不具铸权资格）', () => {
    expect(extractStandingGrantTarget('mail_send', { subject: 'hi' })).toBeNull();
  });

  it('IM send: receive_id + receive_id_type 组成 target（嵌套 data 或摊平都取到）', () => {
    expect(extractStandingGrantTarget('mcp__lark__im_v1_message_create', {
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: 'oc_C1', msg_type: 'text' },
    })).toBe('chat_id:oc_C1');
    // 模型摊平到顶层
    expect(extractStandingGrantTarget('mcp__feishu__send_message', {
      receive_id: 'ou_u1', receive_id_type: 'open_id',
    })).toBe('open_id:ou_u1');
    // 同一 id 不同 id_type → 不同 target（绝不跨类型复用）
    const asChat = extractStandingGrantTarget('mcp__lark__im_v1_message_create', { data: { receive_id: 'X' }, params: { receive_id_type: 'chat_id' } });
    const asOpen = extractStandingGrantTarget('mcp__lark__im_v1_message_create', { data: { receive_id: 'X' }, params: { receive_id_type: 'open_id' } });
    expect(asChat).not.toBe(asOpen);
  });

  it('IM send: 无 receive_id → null（提取不到即不具资格，回退每次询问）', () => {
    expect(extractStandingGrantTarget('mcp__slack__chat_postMessage', { text: 'hi' })).toBeNull();
  });

  it('非 external / 无登记提取器的工具 → null（exec/写文件/未知 external 永远没资格）', () => {
    expect(extractStandingGrantTarget('Bash', { command: 'ls' })).toBeNull();
    expect(extractStandingGrantTarget('Write', { file_path: '/etc/hosts', content: 'x' })).toBeNull();
    // external 但未登记提取器（如未来新增未适配的 IM read）→ null
    expect(extractStandingGrantTarget('mcp__lark__im_chat_list', {})).toBeNull();
  });

  it('模型无法通过 args 自铸权：附带伪造授权字段一律被忽略（no-self-grant）', () => {
    // 模型在 args 里塞 standingGrant/allowForever 等字段，提取器只认真实 target 字段，
    // 这些伪造字段完全不参与、也不能凭空造出 target。
    expect(extractStandingGrantTarget('Bash', { command: 'ls', standingGrant: true, allowForever: 'yes' })).toBeNull();
    // mail_send 即便带伪造字段，target 仍只由 to 决定
    expect(extractStandingGrantTarget('mail_send', { to: ['a@x.com'], grant: 'forever' })).toBe('a@x.com');
  });
});
