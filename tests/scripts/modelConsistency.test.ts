// ============================================================================
// 模型元数据一致性门
//
// src/host/model/modelValidator.ts 校验 PROVIDER_REGISTRY 与 DEFAULT_MODELS /
// CONTEXT_WINDOWS / MODEL_PRICING_PER_1M / VISION_MODEL_CAPABILITIES 的一致性。
// 它此前的唯一调用方是 app/initBackgroundServices.ts —— 那条不在任何发行版中执行的
// Electron main 路径（见 src/host/index.ts 头注释），所以从来没跑过。
//
// 接回来时**没有接进启动期**，而是做成 CI 门。理由：
//   - 它只 logger.warn，不改变任何行为。Neo 的用户默认是非程序员协作者，
//     启动日志里的告警没有任何人会读到，等于接了个寂寞；
//   - 而它真正能防的是"加了模型却漏配价格/上下文窗口"这类提交期错误，
//     这类错误应该在 PR 阶段就被挡住，而不是发到用户机器上打条日志。
//
// 与借鉴清单 B5（models.dev 构建期模型元数据对账）是同一件事：做 B5 前先看这个文件，
// 运行时校验器仓里早就有，只是没接电。
// ============================================================================
import { describe, expect, it } from 'vitest';
import { validateModelConsistency } from '../../src/host/model/modelValidator';

describe('模型元数据一致性（PROVIDER_REGISTRY × 常量表）', () => {
  it('注册模型与各常量表零不匹配', () => {
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
