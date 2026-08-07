// ============================================================================
// `_meta` 注入体积门
// ============================================================================
// 这个常量是**每个工具**都复制一份的常驻 input token 开销，而且是按请求付、
// 22 个核心工具乘 22 份。2026-08-07 实测：核心工具定义本体 7473 token，注入的
// _meta 6094 token —— 占整包 44.9%。谁往里加字段、加描述，这道门先红。
//
// 上限怎么定的：瘦身前 277 / 瘦身后 182 token（gpt-tokenizer / cl100k，与仓库
// tokenEstimator 同一个 encoder；OpenAI 路径 287 → 192），22 个核心工具合计省
// 约 2.1K input token/请求。留 4% 余量取 190。想突破就先拿真库填充率说话：
// #997 之后 targetContext 42.8%、expectedOutcome 39.5% 都在被填也都在渲染，
// 所以这两个字段留着；iconHint 只有 8.4%，是下一个可砍的（省 21 token/工具）。
// ============================================================================

import { describe, it, expect } from 'vitest';
import { encode } from 'gpt-tokenizer';
import type { ToolDefinition } from '../../../src/shared/contract';
import { convertToolsToClaude, convertToolsToOpenAI } from '../../../src/host/model/providers/shared';

const META_TOKEN_CEILING = 190;
/** OpenAI 路径还要过 normalizeJsonSchema（给每个 object 补 additionalProperties），比原样贵一点。 */
const META_TOKEN_CEILING_OPENAI = 205;

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
    // targetContext：TargetContextIcon 按 kind 渲图标；expectedOutcome：
    // toolExecutionPresentation 的 errorWithOutcome 文案。真库填充率都在 40% 上下。
    expect(Object.keys(meta.properties).sort()).toEqual(
      ['expectedOutcome', 'shortDescription', 'targetContext'],
    );
  });
});
