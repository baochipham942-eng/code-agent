// ============================================================================
// `_meta` 注入体积门
// ============================================================================
// 这个常量是**每个工具**都复制一份的常驻 input token 开销，而且是按请求付、
// 22 个核心工具乘 22 份。2026-08-07 实测：核心工具定义本体 7473 token，注入的
// _meta 6094 token —— 占整包 44.9%。谁往里加字段、加描述，这道门先红。
//
// 上限怎么定的（两轮）：
//   277 → 182（2026-08-07 #1018，压描述文本）→ 108（本批，拿掉 targetContext）
//   OpenAI 路径（多过一道 normalizeJsonSchema）：287 → 192 → 113
// 留约 6% 余量取 115 / 125。22 个核心工具累计省约 3.7K input token/请求。
//
// **拿掉 targetContext 是这条字段完整性断言的唯一一次合法放宽**，理由在
// shared.ts 的常量注释里：它的可见产出只是一个由 kind 决定的 12px 图标，
// `label` 从不作为可见文字渲染，而 kind 是工具名的函数——改由渲染端
// deriveToolTargetContext 推，模型不用再填。**下一个想删字段的人别拿这条当先例**：
// expectedOutcome 是自由文本、推导不出来，真库填充率 39.5%，删了就是丢能力。
// ============================================================================

import { describe, it, expect } from 'vitest';
import { encode } from 'gpt-tokenizer';
import type { ToolDefinition } from '../../../src/shared/contract';
import { convertToolsToClaude, convertToolsToOpenAI } from '../../../src/host/model/providers/shared';
import { TOOL_ENVELOPE_CONVENTIONS } from '../../../src/host/prompts/builder';

const META_TOKEN_CEILING = 115;
/** OpenAI 路径还要过 normalizeJsonSchema（给每个 object 补 additionalProperties），比原样贵一点。 */
const META_TOKEN_CEILING_OPENAI = 125;

const probe: ToolDefinition = {
  name: 'probe',
  description: 'probe',
  inputSchema: { type: 'object', properties: {}, required: [] },
  requiresPermission: false,
  permissionLevel: 'read',
};

function metaTokensOf(schema: unknown): number {
  const meta = (schema as { properties?: Record<string, unknown> }).properties?._meta;
  expect(meta, '_meta 必须被注入到 inputSchema.properties').toBeDefined();
  return encode(JSON.stringify(meta)).length;
}

describe('_meta schema 体积门', () => {
  it('Claude 路径注入的 _meta 不超过预算', () => {
    const tokens = metaTokensOf(convertToolsToClaude([probe])[0].input_schema);
    expect(tokens).toBeLessThanOrEqual(META_TOKEN_CEILING);
  });

  it('OpenAI 路径（含 normalizeJsonSchema）注入的 _meta 不超过预算', () => {
    const tokens = metaTokensOf(convertToolsToOpenAI([probe])[0].function.parameters);
    expect(tokens).toBeLessThanOrEqual(META_TOKEN_CEILING_OPENAI);
  });

  it('省 token 不能省掉 UI 真正在用的字段', () => {
    const meta = (convertToolsToClaude([probe])[0].input_schema as {
      properties: { _meta: { properties: Record<string, unknown>; required: string[] } };
    }).properties._meta;
    // shortDescription：工具行主文案，没有它 bash + 一长串命令推不出好文案。
    expect(meta.required).toContain('shortDescription');
    // expectedOutcome：toolExecutionPresentation 的 errorWithOutcome 文案，
    // 自由文本推导不出来，真库填充率 39.5%。
    expect(Object.keys(meta.properties).sort()).toEqual(
      ['expectedOutcome', 'shortDescription'],
    );
    // targetContext 已改渲染端推导，模型不该再被要求填。
    expect(meta.properties).not.toHaveProperty('targetContext');
  });

  it('提示词与 schema 必须同增同减——prompt 不许教 schema 里没有的字段', () => {
    // 教了但 schema 没有：OpenAI strict 模式直接报错，且白烧 token。
    // 这两处历史上是分开写的，本批同步删 targetContext 时才发现提示词也在教它。
    expect(TOOL_ENVELOPE_CONVENTIONS).not.toContain('targetContext');
    expect(TOOL_ENVELOPE_CONVENTIONS).toContain('shortDescription');
    expect(TOOL_ENVELOPE_CONVENTIONS).toContain('expectedOutcome');
  });
});
