// ============================================================================
// ADR-019 批 2：单一决策入口接线 — 源码契约测试
//
// 不变量：所有模型路由决策点必须经过 resolveModelDecision / resolveTierModelConfig /
// resolveProviderBillingMode，禁止散落的 inline adaptive 判断。
// 采用源码契约测试（与 subagentExecutor.abortPropagation.test.ts 同模式）：
// 接线本身是机械集成，runtime mock 链成本远超价值，源码扫描足以防回归。
// ============================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../../..');

const INFERENCE_PATH = path.join(ROOT, 'src/main/agent/runtime/contextAssembly/inference.ts');
const MODEL_ROUTER_PATH = path.join(ROOT, 'src/main/model/modelRouter.ts');
const AGENT_DEFINITION_PATH = path.join(ROOT, 'src/main/agent/agentDefinition.ts');

describe('单一决策入口接线（ADR-019 批 2）', () => {
  it('aiSdk 引擎（inference.ts）的 adaptive 判断必须经 resolveModelDecision + 计费门控', () => {
    const source = readFileSync(INFERENCE_PATH, 'utf8');

    expect(source).toMatch(/resolveModelDecision\(/);
    expect(source).toMatch(/resolveProviderBillingMode\(/);
    // 决策判断不再直接依赖 adaptiveRouter.estimateComplexity（收口到决策入口内部）
    const simpleTaskFn = source.slice(
      source.indexOf('function resolveAdaptiveSimpleTaskConfig'),
      source.indexOf('function estimateInferenceInputTokens'),
    );
    expect(simpleTaskFn).not.toMatch(/estimateComplexity\(/);
  });

  it('legacy 引擎（modelRouter.ts）的 adaptive 判断必须经 resolveModelDecision + 计费门控', () => {
    const source = readFileSync(MODEL_ROUTER_PATH, 'utf8');

    expect(source).toMatch(/resolveModelDecision\(/);
    expect(source).toMatch(/resolveProviderBillingMode\(/);
  });

  it('agentDefinition 的档位解析必须经 resolveTierModelConfig（分发版无硬编码）', () => {
    const source = readFileSync(AGENT_DEFINITION_PATH, 'utf8');

    expect(source).toMatch(/resolveTierModelConfig\(/);
  });
});
