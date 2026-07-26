// ============================================================================
// 模型元数据一致性门
//
// src/host/model/modelValidator.ts 校验 PROVIDER_REGISTRY 与 DEFAULT_MODELS /
// CONTEXT_WINDOWS / MODEL_PRICING_PER_1M / VISION_MODEL_CAPABILITIES 的一致性。
// 它曾经只挂在已删除的 app/initBackgroundServices.ts 死入口，因此发行版从未执行。
// 现在由 webStartupServices 做非阻塞启动校验，同时保留本 CI 门：运行时只 warn，
// PR 阶段仍应直接挡住元数据漂移。
//
// **它到底查什么（别高估）**：只查单向——四张常量表里的每个 key 必须在 PROVIDER_REGISTRY
// 中注册。也就是说它防的是"模型从 registry 删了/改名了，价格表·上下文窗口表里留下孤条目"
// 这类陈旧数据。它**不**查反向：新增模型却没配价格是查不出来的（实测删掉
// MODEL_PRICING_PER_1M['deepseek-chat'] 本门照样绿）。
// 反向校验没有一起加：多数模型本就走 'default' 价格兜底，加反向会大面积亮灯并需要另立基线，
// 属独立一项（与借鉴清单 B5 合并考虑更合适）。
//
// 与借鉴清单 B5（models.dev 构建期模型元数据对账）是同一件事：做 B5 前先看这个文件，
// 运行时校验器仓里早就有，只是没接电。
// ============================================================================
import { describe, expect, it } from 'vitest';
import { validateModelConsistency } from '../../src/host/model/modelValidator';

describe('模型元数据一致性（常量表 → PROVIDER_REGISTRY 单向）', () => {
  it('四张常量表里没有指向未注册模型的孤条目', () => {
    const result = validateModelConsistency();

    // 自检：扫描到的模型数必须是正常量级。若 registry 因导入顺序/重构变空，
    // warnings 自然也是 0 —— 那是"什么都没检查"而不是"检查通过"，必须报红。
    expect(
      result.registeredModelCount,
      '注册模型数异常偏低，说明 PROVIDER_REGISTRY 没被正确加载，本门当前什么都没校验到（零命中≠通过）',
    ).toBeGreaterThan(50);

    expect(
      result.warnings,
      `模型元数据不一致 ${result.warnings.length} 处：\n${result.warnings.map((w) => `  - ${w}`).join('\n')}\n`
      + '新增模型时需同步 DEFAULT_MODELS / CONTEXT_WINDOWS / MODEL_PRICING_PER_1M / VISION_MODEL_CAPABILITIES。',
    ).toEqual([]);
    expect(result.valid).toBe(true);
  });
});
