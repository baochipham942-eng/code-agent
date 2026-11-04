// ============================================================================
// OutboundSecretMask 单测（N-PROMPT-SECRET-MASK ①②④）
// ① 各密钥种类正/负例；同值同占位符；掩码后不含原值。
// ② 还原：纯文本、JSON 工具参数（引号/反斜杠往返）、流式占位符 2/3 分片、complete 冲刷尾巴。
// ④ thinking / responsesOutput 两个方向都不动。
// fail-closed：掩码/还原异常 → 带稳定 code 的可读错误。
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';

const maskSettingsState = vi.hoisted(() => ({ settings: {} as Record<string, unknown> | undefined }));

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => maskSettingsState.settings }),
}));

import { applyOutboundSecretMask } from '../../../src/host/security/outboundSecretMask';
import type { ModelMessage, ModelResponse, StreamChunk } from '../../../src/host/model/types';

const PLACEHOLDER_RE = /\{\{SECRET_[A-Z0-9_]+_[0-9a-f]{8}\}\}/;

function maskOn(): void {
  maskSettingsState.settings = { privacy: { outboundSecretMask: true } };
}

function maskOff(): void {
  maskSettingsState.settings = {};
}

/** 掩一段文本，返回掩后的文本与占位符（secret 供还原断言用）。 */
function maskOne(text: string): { masked: string; placeholder: string } {
  maskOn();
  const session = applyOutboundSecretMask([{ role: 'user', content: text }]);
  if (!session) throw new Error('mask session missing (setting on)');
  const masked = session.messages[0].content;
  if (typeof masked !== 'string') throw new Error('content should stay a string');
  const found = masked.match(PLACEHOLDER_RE);
  if (!found) throw new Error(`no placeholder in: ${masked}`);
  return { masked, placeholder: found[0] };
}

function session(): NonNullable<ReturnType<typeof applyOutboundSecretMask>> {
  maskOn();
  const s = applyOutboundSecretMask([{ role: 'user', content: 'x' }]);
  if (!s) throw new Error('mask session missing');
  return s;
}

/** 收集流回调下发内容的测试替身。 */
function collector(): { chunks: Array<string | StreamChunk>; onStream: (chunk: string | StreamChunk) => void } {
  const chunks: Array<string | StreamChunk> = [];
  return { chunks, onStream: (chunk) => { chunks.push(chunk); } };
}

function joinedText(chunks: Array<string | StreamChunk>): string {
  return chunks
    .filter((chunk): chunk is StreamChunk => typeof chunk !== 'string' && chunk.type === 'text')
    .map((chunk) => chunk.content ?? '')
    .join('');
}

// ---------------------------------------------------------------------------
// ① 各密钥种类
// ---------------------------------------------------------------------------

describe('outboundSecretMask ① 各密钥种类正例', () => {
  beforeEach(maskOn);

  const cases: Array<{ kind: string; text: string; secret: string }> = [
    { kind: 'openai-key', text: 'key is sk-Abc123defGHI789xyz ok', secret: 'Abc123defGHI789xyz' },
    { kind: 'google-api-key', text: 'gcp AIzaSyA1234567890BCDEFGh end', secret: 'AIzaSyA1234567890BCDEFGh' },
    { kind: 'ak-prefixed-key', text: 'longcat ak_Abcdefghij1234567890 here', secret: 'ak_Abcdefghij1234567890' },
    { kind: 'github-ghp-token', text: 'git ghp_Abcdefghij1234567890 done', secret: 'ghp_Abcdefghij1234567890' },
    { kind: 'github-gho-token', text: 'oauth gho_Abcdefghij1234567890 done', secret: 'gho_Abcdefghij1234567890' },
    {
      kind: 'github-fine-grained-pat',
      text: `pat github_pat_${'A1b2C3d4E5'.repeat(9)} done`,
      secret: `github_pat_${'A1b2C3d4E5'.repeat(9)}`,
    },
    { kind: 'slack-xox-token', text: 'slack xoxb-1234567890abcdefXYZ here', secret: 'xoxb-1234567890abcdefXYZ' },
    { kind: 'slack-xapp-token', text: 'slack xapp-1-A123-456-789 here', secret: 'xapp-1-A123-456-789' },
    { kind: 'aws-access-key-id', text: 'aws AKIAABCDEFGHIJKLMNOP here', secret: 'AKIAABCDEFGHIJKLMNOP' },
    { kind: 'url-basic-auth', text: 'fetch https://user:passw0rd123@example.com/x now', secret: 'user:passw0rd123' },
    { kind: 'cookie-header', text: 'Cookie: sessionid=abcdef123456 tail', secret: 'sessionid=abcdef123456' },
    { kind: 'session-cookie-assignment', text: 'session_cookie=abc123def456 end', secret: 'abc123def456' },
    { kind: 'env-secret-assignment', text: 'MY_APP_TOKEN=tok_abcdef123456 end', secret: 'tok_abcdef123456' },
    { kind: 'url-query-token', text: 'go https://example.com/api?access_token=abcdef123456&x=1 now', secret: 'abcdef123456' },
    {
      kind: 'jwt-token',
      text: 'jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdef1234567890 tail',
      secret: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdef1234567890',
    },
    {
      kind: 'pem-private-key',
      text: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1example\n-----END RSA PRIVATE KEY-----',
      secret: 'MIIEowIBAAKCAQEA1example',
    },
  ];

  it.each(cases)('$kind 掩掉值且保留周边文本', async ({ text, secret }) => {
    const s = applyOutboundSecretMask([{ role: 'user', content: text }]);
    expect(s).toBeDefined();
    const masked = s!.messages[0].content as string;
    expect(masked).toMatch(PLACEHOLDER_RE);
    expect(masked).not.toContain(secret);
    expect(masked).not.toContain(secret.slice(0, Math.min(secret.length, 6)));
    // 非密钥的周边文本不丢
    expect(masked.length).toBeGreaterThan('{{SECRET_}}'.length);
  });

  it('env 赋值只掩值：键名留在明文', async () => {
    const { masked } = maskOne('ANTHROPIC_API_KEY=sk-ant-api03-abcdef1234567890');
    expect(masked).toMatch(/^ANTHROPIC_API_KEY=\{\{SECRET_/);
    expect(masked).not.toContain('sk-ant-api03-abcdef1234567890');
  });

  it('openai key 前缀 sk- 留在明文', async () => {
    const { masked } = maskOne('key sk-Abc123defGHI789xyz');
    expect(masked).toContain('sk-{{SECRET_OPENAI_KEY_');
  });

  it('pem 整块替换，BEGIN/END 头尾不再出现', async () => {
    const { masked } = maskOne('-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----');
    expect(masked).not.toContain('BEGIN');
    expect(masked).toMatch(/^\{\{SECRET_PRIVATE_KEY_[0-9a-f]{8}\}\}$/);
  });
});

describe('outboundSecretMask ① 负例（不该掩的别动）', () => {
  beforeEach(maskOn);

  it.each([
    ['bearer 短令牌（<20 字符）', 'Authorization: Bearer abcdefgh12345678'],
    ['bearer 散文', 'Bearer authentication scheme is described in RFC 6750'],
    ['bearer 长但无数字', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz'],
    ['bearer 小写（区分大小写）', 'authorization: bearer abcdefghij0123456789klmn'],
    ['13 位时间戳', 'created at 1700000000000 ms'],
    ['Luhn 不合规的 16 位', 'card 4111 1111 1111 1112'],
    ['更长数字串里嵌着 Luhn 合规号', 'id 94111111111111111 end'],
    ['数字紧贴字母', 'order A4111111111111111'],
    ['UUID 尾段', 'surface_11111111-2222-3333-4444-555555555555'],
    ['小数点相邻', 'ratio 0.4111111111111111'],
    ['Luhn 合规但无已知发卡段', 'ref 9999999999999995'],
    ['MAX_TOKENS 数字赋值', 'MAX_TOKENS = 128000'],
    ['普通 token 变量名', 'const token = userToken;'],
    ['占位符值', 'MY_API_KEY=your-api-key-here'],
    ['小写 env 键', 'my_api_key=abcdefgh1234'],
    ['普通文本', 'hello world, nothing secret here'],
  ])('%s 原样', async (_name, text) => {
    const s = applyOutboundSecretMask([{ role: 'user', content: text }]);
    expect(s!.messages[0].content).toBe(text);
  });

  it('普通文本消息数组保持同引用（零改动零分配）', async () => {
    const messages: ModelMessage[] = [
      { role: 'system', content: 'you are helpful' },
      { role: 'user', content: 'hi' },
    ];
    expect(applyOutboundSecretMask(messages)!.messages).toBe(messages);
  });

  it('掩码不改动入参消息（含 toolCalls/toolCallText）', async () => {
    const original: ModelMessage[] = [
      { role: 'user', content: 'key sk-Abc123defGHI789xyz' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: '1', name: 'write', arguments: '{"content":"MY_SECRET=ab\\cdef12345"}' }],
        toolCallText: 'MY_SECRET=ab\\cdef12345',
      },
    ];
    const snapshot = JSON.stringify(original);
    applyOutboundSecretMask(original);
    expect(JSON.stringify(original)).toBe(snapshot);
  });
});

describe('outboundSecretMask ① 同值同占位符 / 跨请求稳定', () => {
  beforeEach(maskOn);

  it('两次独立请求里同一值得到同一占位符', async () => {
    const first = maskOne('a sk-Abc123defGHI789xyz b');
    const second = maskOne('completely different text with sk-Abc123defGHI789xyz inside');
    expect(second.placeholder).toBe(first.placeholder);
  });

  it('同一段 .env 全文掩码后不含任何原值', async () => {
    const envFile = [
      '# my env',
      'ZHIPU_API_KEY=abcd1234efgh5678',
      'GITHUB_TOKEN=ghp_Abcdefghij1234567890',
      'AWS_KEY=AKIAABCDEFGHIJKLMNOP',
      '',
    ].join('\n');
    const masked = applyOutboundSecretMask([{ role: 'user', content: envFile }])!.messages[0].content as string;
    expect(masked).toContain('# my env');
    expect(masked).not.toContain('abcd1234efgh5678');
    expect(masked).not.toContain('ghp_Abcdefghij1234567890');
    expect(masked).not.toContain('AKIAABCDEFGHIJKLMNOP');
  });
});

// ---------------------------------------------------------------------------
// ② 还原
// ---------------------------------------------------------------------------

describe('outboundSecretMask ② 还原', () => {
  beforeEach(maskOn);

  it('纯文本回复还原出原值', async () => {
    const { placeholder } = maskOne('key sk-Abc123defGHI789xyz');
    const restored = session().restore({ type: 'text', content: `value = ${placeholder}` });
    expect(restored.content).toBe('value = Abc123defGHI789xyz');
  });

  it.each([
    ['sk-', 'https://api.example.com/v1?api_key=sk-Abc123defGHI789xyz&x=1'],
    ['AIza', 'https://maps.example.com/v1?key=1&token=AIzaSyA1234567890abcdefghijklmnopqrstuv'],
  ])('嵌套命中（%s 前缀规则 + url-query-token）：回包不留内层占位符', async (_label, url) => {
    maskOn();
    const s = applyOutboundSecretMask([{ role: 'user', content: `curl "${url}"` }]);
    const masked = s!.messages[0].content as string;
    expect(masked).not.toContain('Abc123defGHI789xyz');
    expect(masked).not.toContain('1234567890abcdefghijklmnopqrstuv');
    const text = s!.restore({ type: 'text', content: masked });
    expect(text.content).toBe(`curl "${url}"`);
    const obj = s!.restore({
      type: 'tool_use',
      toolCalls: [{ id: 'c', name: 'bash', arguments: { cmd: masked } }],
    });
    expect((obj.toolCalls![0].arguments as Record<string, unknown>).cmd).toBe(`curl "${url}"`);
    const { chunks, onStream } = collector();
    const wrapped = applyOutboundSecretMask([{ role: 'user', content: 'x' }], onStream)!;
    await wrapped.onStream?.({ type: 'tool_call_start', toolCall: { index: 0, id: 'c1', name: 'bash' } });
    await wrapped.onStream?.({ type: 'tool_call_delta', toolCall: { index: 0, argumentsDelta: JSON.stringify({ cmd: masked }) } });
    await wrapped.onStream?.({ type: 'complete', finishReason: 'stop' });
    const args = chunks
      .filter((chunk): chunk is StreamChunk => typeof chunk !== 'string' && chunk.type === 'tool_call_delta')
      .map((chunk) => chunk.toolCall?.argumentsDelta)
      .join('');
    expect(JSON.parse(args).cmd).toBe(`curl "${url}"`);
    expect(args).not.toContain('{{SECRET_');
  });

  it('未知占位符原样保留', async () => {
    const restored = session().restore({ type: 'text', content: 'keep {{SECRET_OPENAI_KEY_00000000}} as is' });
    expect(restored.content).toBe('keep {{SECRET_OPENAI_KEY_00000000}} as is');
  });

  it('工具参数对象形态：字符串叶子还原为掩码时的原切片', async () => {
    // 出云 arguments 是 JSON 字符串；JSON 里一个反斜杠写作两个反斜杠字符。
    // 掩码作用于 JSON 原文，映射里存的是原文切片（含转义形态）——对象形态还原
    // 原样给回该切片，JSON 文本形态（argumentsDelta）则再转义，两边字节都能对上。
    const rawArgs = '{"env":"MY_SECRET=ab\\\\cdef12345"}';
    const messages: ModelMessage[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'write', arguments: rawArgs }] },
    ];
    const s = applyOutboundSecretMask(messages)!;
    const maskedArgs = s.messages[0].toolCalls![0].arguments;
    expect(maskedArgs).not.toContain('MY_SECRET=ab');
    const placeholder = maskedArgs.match(PLACEHOLDER_RE)![0];
    const restored = s.restore({
      type: 'tool_use',
      toolCalls: [{ id: 't1', name: 'write', arguments: { env: placeholder } }],
    });
    expect((restored.toolCalls![0].arguments as Record<string, unknown>).env).toBe('ab\\\\cdef12345');
  });

  it('JSON 文本形态还原时值被 JSON 转义（引号/反斜杠/换行往返）', async () => {
    // 先以纯文本掩一个含引号+反斜杠+换行的私钥块：占位符映射到带真实特殊字符的原值
    const pem = '-----BEGIN PRIVATE KEY-----\nab"cd\\ef\n-----END PRIVATE KEY-----';
    const { placeholder } = maskOne(pem);
    // 再让模型的 argumentsDelta（JSON 文本片段）里出现该占位符
    const { chunks, onStream } = collector();
    const wrapped = applyOutboundSecretMask([{ role: 'user', content: 'x' }], onStream)!;
    await wrapped.onStream?.({ type: 'tool_call_start', toolCall: { index: 0, id: 'c1', name: 'write' } });
    await wrapped.onStream?.({ type: 'tool_call_delta', toolCall: { index: 0, argumentsDelta: `{"content":"${placeholder.slice(0, 10)}` } });
    await wrapped.onStream?.({ type: 'tool_call_delta', toolCall: { index: 0, argumentsDelta: `${placeholder.slice(10)}"}` } });
    await wrapped.onStream?.({ type: 'complete', finishReason: 'stop' });
    const args = chunks
      .filter((chunk): chunk is StreamChunk => typeof chunk !== 'string' && chunk.type === 'tool_call_delta')
      .map((chunk) => chunk.toolCall?.argumentsDelta)
      .join('');
    expect(args).toBe('{"content":"-----BEGIN PRIVATE KEY-----\\nab\\"cd\\\\ef\\n-----END PRIVATE KEY-----"}');
  });

  it('contentParts 文本件一并还原', async () => {
    const { placeholder } = maskOne('sk-Abc123defGHI789xyz');
    const restored = session().restore({
      type: 'text',
      content: `a ${placeholder}`,
      contentParts: [{ type: 'text', text: `a ${placeholder}` }, { type: 'tool_call', toolCallId: 't1' }],
    });
    expect(restored.contentParts?.[0]).toEqual({ type: 'text', text: 'a Abc123defGHI789xyz' });
  });
});

describe('outboundSecretMask ② 流式还原与尾巴驻留', () => {
  beforeEach(maskOn);

  it('占位符劈成 2 个分片：第一片只发安全前缀，第二片还原整值', async () => {
    const { placeholder } = maskOne('key sk-Abc123defGHI789xyz');
    const mid = Math.floor(placeholder.length / 2);
    const { chunks, onStream } = collector();
    const wrapped = applyOutboundSecretMask([{ role: 'user', content: 'x' }], onStream)!;
    await wrapped.onStream?.({ type: 'text', content: `the key sk-${placeholder.slice(0, mid)}` });
    await wrapped.onStream?.({ type: 'text', content: `${placeholder.slice(mid)} wait` });
    await wrapped.onStream?.({ type: 'complete', finishReason: 'stop' });
    expect(joinedText(chunks)).toBe('the key sk-Abc123defGHI789xyz wait');
  });

  it('占位符劈成 3 个分片也能整值还原', async () => {
    const { placeholder } = maskOne('key sk-Abc123defGHI789xyz');
    const third = Math.ceil(placeholder.length / 3);
    const parts = [placeholder.slice(0, third), placeholder.slice(third, 2 * third), placeholder.slice(2 * third)];
    const { chunks, onStream } = collector();
    const wrapped = applyOutboundSecretMask([{ role: 'user', content: 'x' }], onStream)!;
    await wrapped.onStream?.({ type: 'text', content: `v=sk-${parts[0]}` });
    await wrapped.onStream?.({ type: 'text', content: parts[1] });
    await wrapped.onStream?.({ type: 'text', content: `${parts[2]}!` });
    await wrapped.onStream?.({ type: 'complete', finishReason: 'stop' });
    expect(joinedText(chunks)).toBe('v=sk-Abc123defGHI789xyz!');
  });

  it('收尾疑似未完占位符在 complete 时原样冲刷', async () => {
    const { chunks, onStream } = collector();
    const wrapped = applyOutboundSecretMask([{ role: 'user', content: 'x' }], onStream)!;
    await wrapped.onStream?.({ type: 'text', content: 'template {{SEC' });
    await wrapped.onStream?.({ type: 'complete', finishReason: 'stop' });
    const textChunks = chunks.filter((chunk): chunk is StreamChunk => typeof chunk !== 'string' && chunk.type === 'text');
    expect(textChunks.map((chunk) => chunk.content)).toEqual(['template ', '{{SEC']);
    expect(chunks[chunks.length - 1]).toMatchObject({ type: 'complete' });
  });

  it('文本尾巴在 tool_call_start 前冲刷；参数分片跨 chunk 还原且 JSON 转义', async () => {
    const { placeholder } = maskOne('MY_SECRET=ab\\cdef12345');
    const { chunks, onStream } = collector();
    const wrapped = applyOutboundSecretMask([{ role: 'user', content: 'x' }], onStream)!;
    await wrapped.onStream?.({ type: 'text', content: `use MY_SECRET=${placeholder}` });
    await wrapped.onStream?.({ type: 'text', content: ' tail {{SEC' });
    await wrapped.onStream?.({ type: 'tool_call_start', toolCall: { index: 0, id: 'c1', name: 'write' } });
    await wrapped.onStream?.({ type: 'tool_call_delta', toolCall: { index: 0, argumentsDelta: '{"s":"' } });
    await wrapped.onStream?.({ type: 'tool_call_delta', toolCall: { index: 0, argumentsDelta: `${placeholder}"}` } });
    await wrapped.onStream?.({ type: 'complete', finishReason: 'stop' });
    // 完整占位符立即还原；未完尾巴在 tool_call_start 前原样冲刷
    expect(joinedText(chunks)).toBe('use MY_SECRET=ab\\cdef12345 tail {{SEC');
    const args = chunks
      .filter((chunk): chunk is StreamChunk => typeof chunk !== 'string' && chunk.type === 'tool_call_delta')
      .map((chunk) => chunk.toolCall?.argumentsDelta)
      .join('');
    expect(args).toBe('{"s":"ab\\\\cdef12345"}');
  });

  it('reasoning 分片直通，与文本互不干扰', async () => {
    const { chunks, onStream } = collector();
    const wrapped = applyOutboundSecretMask([{ role: 'user', content: 'x' }], onStream)!;
    await wrapped.onStream?.({ type: 'text', content: 'hello {{SEC' });
    await wrapped.onStream?.({ type: 'reasoning', content: 'thinking hard' });
    await wrapped.onStream?.({ type: 'text', content: 'RET_X}}' });
    await wrapped.onStream?.({ type: 'complete', finishReason: 'stop' });
    const reasoning = chunks.filter((chunk): chunk is StreamChunk => typeof chunk !== 'string' && chunk.type === 'reasoning');
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0].content).toBe('thinking hard');
    // 未知完整占位符不还原，原样拼回
    expect(joinedText(chunks)).toBe('hello {{SECRET_X}}');
  });

  it('legacy 字符串分片同样还原', async () => {
    const { placeholder } = maskOne('key sk-Abc123defGHI789xyz');
    const { chunks, onStream } = collector();
    const wrapped = applyOutboundSecretMask([{ role: 'user', content: 'x' }], onStream)!;
    await wrapped.onStream?.(`key ${placeholder.slice(0, 8)}`);
    await wrapped.onStream?.(placeholder.slice(8));
    await wrapped.onStream?.({ type: 'complete', finishReason: 'stop' });
    const strings = chunks.filter((chunk): chunk is string => typeof chunk === 'string');
    expect(strings.join('')).toBe('key Abc123defGHI789xyz');
  });
});

// ---------------------------------------------------------------------------
// ④ thinking / responsesOutput 不动
// ---------------------------------------------------------------------------

describe('outboundSecretMask ④ thinking / responsesOutput 不动', () => {
  beforeEach(maskOn);

  it('出云方向：thinking 字段/部件、responsesOutput 原样（同引用）', async () => {
    const thinkingPart = { type: 'thinking' as const, thinking: 'secret sk-Abc123defGHI789xyz thought' };
    const responsesOutput = [{ type: 'message', content: 'sk-Abc123defGHI789xyz' }];
    const messages: ModelMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'visible sk-Abc123defGHI789xyz here' },
          thinkingPart,
        ],
        thinking: 'private sk-Abc123defGHI789xyz',
        responsesOutput,
      },
    ];
    const out = applyOutboundSecretMask(messages)!.messages[0];
    expect(out.thinking).toBe('private sk-Abc123defGHI789xyz');
    expect(out.responsesOutput).toBe(responsesOutput);
    const parts = out.content as Array<{ type: string; text?: string }>;
    expect(parts[1]).toBe(thinkingPart);
    expect(parts[0].text).not.toContain('Abc123defGHI789xyz');
    expect(parts[0].text).toMatch(PLACEHOLDER_RE);
  });

  it('回包方向：content 还原但 thinking 里的占位符不还原', async () => {
    const { placeholder } = maskOne('key sk-Abc123defGHI789xyz');
    const restored = session().restore({
      type: 'thinking',
      content: `plain ${placeholder}`,
      thinking: `reasoning ${placeholder}`,
    });
    expect(restored.content).toBe('plain Abc123defGHI789xyz');
    expect(restored.thinking).toBe(`reasoning ${placeholder}`);
  });
});

// ---------------------------------------------------------------------------
// 开关与 fail-closed
// ---------------------------------------------------------------------------

describe('outboundSecretMask 开关与 fail-closed', () => {
  it('开关关（缺省）返回 undefined', async () => {
    maskOff();
    expect(applyOutboundSecretMask([{ role: 'user', content: 'sk-Abc123defGHI789xyz' }])).toBeUndefined();
  });

  it('settings 读取抛错按关处理（不炸请求）', async () => {
    maskSettingsState.settings = undefined;
    expect(applyOutboundSecretMask([{ role: 'user', content: 'x' }])).toBeUndefined();
  });

  it('掩码阶段异常 → 带稳定 code 的可读错误，提示可在设置里关闭', async () => {
    maskOn();
    const evil = { role: 'user', content: 'ok' } as ModelMessage;
    Object.defineProperty(evil, 'content', {
      get() {
        throw new Error('boom');
      },
    });
    expect(() => applyOutboundSecretMask([evil])).toThrow(/OUTBOUND_SECRET_MASK_FAILED/);
    expect(() => applyOutboundSecretMask([evil])).toThrow(/Settings > Privacy/);
  });

  it('还原阶段异常 → 带稳定 code 的可读错误', async () => {
    maskOn();
    const s = session();
    const evilResponse = { type: 'text' } as ModelResponse;
    Object.defineProperty(evilResponse, 'content', {
      get() {
        throw new Error('boom');
      },
    });
    expect(() => s.restore(evilResponse)).toThrow(/OUTBOUND_SECRET_MASK_RESTORE_FAILED/);
  });
});


describe('outboundSecretMask FU1 BEARER / CARD', () => {
  beforeEach(maskOn);

  const TOKEN = 'eyJhbGciOiJIUzI1NiJ9abcd1234efgh5678';
  const CARD = '4111 1111 1111 1111';

  it('bearer：只掩令牌，Bearer 前缀留明文', () => {
    const { masked } = maskOne(`Authorization: Bearer ${TOKEN.replace('eyJ', 'zzz')}`);
    expect(masked).toMatch(/^Authorization: Bearer \{\{SECRET_BEARER_TOKEN_[0-9a-f]{8}\}\}$/);
  });

  it.each([
    ['visa 空格分组', '4111 1111 1111 1111'],
    ['visa 连续', '4111111111111111'],
    ['visa 短横', '4111-1111-1111-1111'],
    ['mastercard 5xxx', '5555 5555 5555 4444'],
    ['mastercard 2-series', '2223003122003222'],
    ['amex', '378282246310005'],
    ['discover', '6011111111111117'],
  ])('card %s 被掩且可原样还原', (_n, card) => {
    const { masked, placeholder } = maskOne(`pay ${card}, thanks`);
    expect(placeholder).toMatch(/^\{\{SECRET_CARD_NUMBER_[0-9a-f]{8}\}\}$/);
    expect(masked).toBe(`pay ${placeholder}, thanks`);
    const restored = session().restore({ content: masked } as ModelResponse);
    expect(restored.content).toBe(`pay ${card}, thanks`);
  });

  it('句末句号不阻止卡号命中', () => {
    const { masked } = maskOne('my card is 4111111111111111.');
    expect(masked).toMatch(/^my card is \{\{SECRET_CARD_NUMBER_[0-9a-f]{8}\}\}\.$/);
  });

  it('同值跨请求同占位符（bearer 与 card）', () => {
    const t1 = maskOne(`Bearer ${TOKEN}`);
    const t2 = maskOne(`x Bearer ${TOKEN} y`);
    expect(t2.placeholder).toBe(t1.placeholder);
    const c1 = maskOne(`card ${CARD}`);
    const c2 = maskOne(`${CARD} again`);
    expect(c2.placeholder).toBe(c1.placeholder);
  });

  it('混合日志：两种都掩，周边订单号/时间戳不动，入参不被改', () => {
    const text = `ts=1700000000000 order=20261102123456\nAuthorization: Bearer ${TOKEN}\ncard ${CARD}`;
    const input: ModelMessage[] = [{ role: 'user', content: text }];
    const snapshot = JSON.stringify(input);
    const s = applyOutboundSecretMask(input)!;
    const out = s.messages[0].content as string;
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(CARD);
    expect(out).toContain('ts=1700000000000 order=20261102123456');
    expect(s.restore({ content: out } as ModelResponse).content).toBe(text);
  });

  it.each([2, 3])('卡号占位符被流式切成 %i 片仍还原', async (pieces) => {
    const { masked } = maskOne(`card ${CARD} ok`);
    const sink = collector();
    const s = applyOutboundSecretMask([{ role: 'user', content: 'x' }], sink.onStream)!;
    const size = Math.ceil(masked.length / pieces);
    for (let i = 0; i < masked.length; i += size) {
      await s.onStream!({ type: 'text', content: masked.slice(i, i + size) });
    }
    await s.onStream!({ type: 'complete' } as StreamChunk);
    expect(joinedText(sink.chunks)).toBe(`card ${CARD} ok`);
  });
});

describe('outboundSecretMask FU2 EMAIL', () => {
  beforeEach(maskOn);

  const EMAIL_PH = /\{\{SECRET_EMAIL_[0-9a-f]{8}\}\}/;
  const masks = (text: string): string => {
    const s = applyOutboundSecretMask([{ role: 'user', content: text }])!;
    return s.messages[0].content as string;
  };

  it.each([
    ['fastmail', 'rina.k@fastmail.com'],
    ['multi-label tld', 'ops@corp.example.co.uk'],
    ['.local', 'admin@build.local'],
    ['two-label internal', 'ops@mail.corp'],
    ['mixed case', 'j@Gmail.COM'],
    ['plus tag', 'rina+tag@fastmail.com'],
    ['gitte 不是 git@', 'gitte@fastmail.com'],
    ['github 不是 git@', 'github@acme-corp.com'],
  ])('mask: %s', (_n, email) => {
    const out = masks(`mail ${email} now`);
    expect(out).toMatch(new RegExp(`^mail ${EMAIL_PH.source} now$`));
    expect(out).not.toContain(email);
    expect(session().restore({ content: out } as ModelResponse).content).toBe(`mail ${email} now`);
  });

  it('Magpie：句末句号不阻止命中', () => {
    expect(masks('email address is jo@quill.dev.')).toMatch(new RegExp(`^email address is ${EMAIL_PH.source}\\.$`));
  });

  it.each([
    ['example.com 文档示例', 'user@example.com'],
    ['example.org 子域', 'a@mail.example.org'],
    ['.example', 'a@host.example'],
    ['.test', 'a@foo.test'],
    ['.invalid', 'a@foo.invalid'],
    ['.localhost', 'a@app.localhost'],
    ['user@example 无 TLD', 'user@example'],
    ['Magpie：pytest.fixture', 'x@pytest.fixture'],
    ['Magpie：follow docs@AGENTS.md', 'follow docs@AGENTS.md'],
    ['Magpie：functools.cache', 'obj@functools.cache'],
    ['Magpie：git@github.com SSH 远程', 'git@github.com:o/r.git'],
    ['Magpie：logo@2x.png', 'logo@2x.png'],
    ['Magpie：261020_14-16-11@2x.jpg', '261020_14-16-11@2x.jpg'],
    ['@decorator', '@dataclass\nclass A: pass'],
    ['@scope 包名', 'npm i @types/node @scope/pkg'],
    ['pkg@1.2.3', 'npm i react@18.3.1 pkg@1.2.3'],
  ])('不掩：%s', (_n, text) => {
    expect(masks(text)).toBe(text);
  });

  it('URL userinfo 不留半掩残渣：凭据规则先走，邮箱规则不再插手', () => {
    const out = masks('clone https://deploy:Xk9Qm2Zp7Rw4Tn8Vb3@repo.acme-corp.com/x.git now');
    expect(out).not.toContain('Xk9Qm2Zp7Rw4Tn8Vb3');
    expect(out).toMatch(/^clone https:\/\/\{\{SECRET_BASIC_AUTH_[0-9a-f]{8}\}\}@repo\.acme-corp\.com\/x\.git now$/);
    expect(out).not.toMatch(/\{\{SECRET_EMAIL_/);
    const plain = masks('open https://user:pw@host.com/path');
    expect(plain).toMatch(/^open https:\/\/\{\{SECRET_BASIC_AUTH_[0-9a-f]{8}\}\}@host\.com\/path$/);
  });

  it('占位符稳定：同地址同占位符，不同地址不同占位符', () => {
    const a1 = maskOne('x rina.k@fastmail.com');
    const a2 = maskOne('rina.k@fastmail.com again');
    const b = maskOne('x rina.j@fastmail.com');
    expect(a2.placeholder).toBe(a1.placeholder);
    expect(b.placeholder).not.toBe(a1.placeholder);
    expect(a1.placeholder).toMatch(/^\{\{SECRET_EMAIL_[0-9a-f]{8}\}\}$/);
  });

  it('JSON 工具参数还原：含 + 与引号的文本往返仍是合法 JSON', () => {
    const email = 'rina+k@fastmail.com';
    const args = JSON.stringify({ to: email, note: `say "hi" to ${email}` });
    const input: ModelMessage[] = [{ role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'send', arguments: args }] }];
    const s = applyOutboundSecretMask(input)!;
    const maskedArgs = s.messages[0].toolCalls![0].arguments;
    expect(maskedArgs).not.toContain(email);
    const restored = s.restore({
      type: 'tool_use',
      toolCalls: [{ id: 't1', name: 'send', arguments: JSON.parse(maskedArgs) as Record<string, unknown> }],
    });
    expect(restored.toolCalls![0].arguments).toEqual({ to: email, note: `say "hi" to ${email}` });
  });

  it.each([2, 3])('邮箱占位符被流式切成 %i 片仍还原', async (pieces) => {
    const { masked } = maskOne('mail rina.k@fastmail.com ok');
    const sink = collector();
    const s = applyOutboundSecretMask([{ role: 'user', content: 'x' }], sink.onStream)!;
    const size = Math.ceil(masked.length / pieces);
    for (let i = 0; i < masked.length; i += size) {
      await s.onStream!({ type: 'text', content: masked.slice(i, i + size) });
    }
    await s.onStream!({ type: 'complete' } as StreamChunk);
    expect(joinedText(sink.chunks)).toBe('mail rina.k@fastmail.com ok');
  });

  it('JSON 文本 arguments 里 \\n/\\t 转义后的邮箱：转义保持合法，JSON 仍可解析且往返一致', () => {
    const email = 'rina@fastmail.com';
    const args = JSON.stringify({ text: `line1\n${email}\t${email}` });
    const s = applyOutboundSecretMask([{ role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'send', arguments: args }] }])!;
    const maskedArgs = s.messages[0].toolCalls![0].arguments;
    expect(maskedArgs).not.toContain(email);
    expect(maskedArgs).not.toContain('\\{');
    const parsed = JSON.parse(maskedArgs) as { text: string };
    expect(parsed.text).toMatch(/^line1\n\{\{SECRET_EMAIL_[0-9a-f]{8}\}\}\t\{\{SECRET_EMAIL_[0-9a-f]{8}\}\}$/);
    const restored = s.restore({ type: 'tool_use', toolCalls: [{ id: 't1', name: 'send', arguments: parsed }] });
    expect(restored.toolCalls![0].arguments).toEqual({ text: `line1\n${email}\t${email}` });
  });
});
