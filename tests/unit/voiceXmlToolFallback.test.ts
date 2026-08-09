import { describe, expect, it } from 'vitest';
import type { VoiceToolDefinition } from '../../src/shared/contract/voice';
import {
  mayBeVoiceXmlFallback,
  parseVoiceXmlToolFallback,
  validateVoiceToolArguments,
} from '../../src/host/services/voice/voiceXmlToolFallback';

const tools: VoiceToolDefinition[] = [
  {
    type: 'function',
    name: 'delegate_task',
    description: '派活',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        short_name: { type: 'string' },
        lane_key: { type: 'string' },
        submission_key: { type: 'string' },
        prompt: { type: 'string' },
        replace_current: { type: 'boolean' },
      },
      required: ['title', 'short_name', 'lane_key', 'submission_key', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'task_status',
    description: '状态',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
];

describe('voice XML tool fallback', () => {
  it('只接受顶层完整块，解码实体并按注册 schema 还原类型', () => {
    const result = parseVoiceXmlToolFallback(`
      <invoke name="delegate_task">
        <parameter name="title">周报</parameter>
        <parameter name="short_name">周报</parameter>
        <parameter name="lane_key">report&amp;weekly</parameter>
        <parameter name="submission_key">turn-1</parameter>
        <parameter name="prompt">生成&lt;本周&gt;报告</parameter>
        <parameter name="replace_current">false</parameter>
      </invoke>
    `, tools);

    expect(result).toEqual({
      kind: 'accepted',
      name: 'delegate_task',
      arguments: JSON.stringify({
        title: '周报',
        short_name: '周报',
        lane_key: 'report&weekly',
        submission_key: 'turn-1',
        prompt: '生成<本周>报告',
        replace_current: false,
      }),
    });
  });

  it.each([
    ['混入正文', '我来处理 <invoke name="task_status"></invoke>', 'not_candidate'],
    ['未知工具', '<invoke name="read_file"></invoke>', 'rejected'],
    ['缺必填字段', '<invoke name="delegate_task"><parameter name="title">周报</parameter></invoke>', 'rejected'],
    ['重复字段', '<invoke name="task_status"><parameter name="x">1</parameter><parameter name="x">2</parameter></invoke>', 'rejected'],
    ['未转义实体', '<invoke name="delegate_task"><parameter name="prompt">A&B</parameter></invoke>', 'rejected'],
    ['尾部注入', '<invoke name="task_status"></invoke><invoke name="task_status"></invoke>', 'rejected'],
  ])('%s 不执行', (_label, text, kind) => {
    expect(parseVoiceXmlToolFallback(text, tools).kind).toBe(kind);
  });

  it('原生 function call 与 fallback 共用同一注册 schema 校验', () => {
    expect(validateVoiceToolArguments('task_status', '{}', tools)).toEqual({ ok: true, arguments: '{}' });
    expect(validateVoiceToolArguments('task_status', '{"extra":true}', tools)).toEqual({
      ok: false,
      reason: 'schema_mismatch',
    });
    expect(validateVoiceToolArguments('delegate_task', '{', tools)).toEqual({
      ok: false,
      reason: 'malformed_json',
    });
  });

  it('只把 invoke 前缀识别为候选', () => {
    expect(mayBeVoiceXmlFallback('<invo')).toBe(true);
    expect(mayBeVoiceXmlFallback('  <invoke name="task_status">')).toBe(true);
    expect(mayBeVoiceXmlFallback('用户说 <invoke')).toBe(false);
  });
});
