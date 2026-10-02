// ============================================================================
// Tool Args Repair Gate — 工具入参 schema 校验失败的 repair 节流闸（Kimi 借鉴 #1）
// ============================================================================
// 背景：toolExecutionEngine 的 validation gate 在工具入参不合 schema 时，把
// schema 信息回灌给模型让它下一轮自我修正。但这个回灌**没有上限**——若模型
// 反复对同一工具传错参数，就会每轮注入 + 每轮重试，正是 Kimi 全网吐槽的
// "工具调用弱 → 卡死循环 → 狂烧 token"。
//
// 本闸按 toolName 统计连续校验失败次数：
//   - 失败 ≤ 上限：照常回灌 schema 让模型修正（repair）
//   - 连续失败 > 上限：停止重注入，改注入终止指引，让模型停止重试该工具、
//     换一条路（或向用户要缺失信息）。surgical：只断这一个工具的死循环，
//     不强制结束整个 run。
//   - 该工具任意一次成功执行：计数清零（恢复了进展）。
//
// 纯逻辑、无副作用，便于单测；与 ARTIFACT_REPAIR（patch/产物修复）是两条
// 独立循环。
// ============================================================================

export interface RepairFailureDecision {
  /** 该工具到目前为止的连续失败次数（含本次） */
  attempt: number;
  /** 是否已超过上限——超过则应走终止指引而非继续 repair */
  exhausted: boolean;
}

export class ToolArgsRepairGate {
  private readonly failures = new Map<string, number>();

  constructor(private readonly maxAttempts: number) {}

  /** 记一次校验失败，返回当前连续失败次数与是否耗尽。 */
  recordFailure(toolName: string): RepairFailureDecision {
    const attempt = (this.failures.get(toolName) ?? 0) + 1;
    this.failures.set(toolName, attempt);
    return { attempt, exhausted: attempt > this.maxAttempts };
  }

  /** 工具成功执行后清零该工具计数（进展恢复）。 */
  recordSuccess(toolName: string): void {
    this.failures.delete(toolName);
  }

  /** run 起点重置全部计数（引擎实例可能跨多轮复用）。 */
  reset(): void {
    this.failures.clear();
  }
}

export interface RepairExhaustedHint {
  /** 连续失败中累计缺过的必填字段名 */
  missingFields: string[];
  /** minimalCallExample 生成的最小合法调用（compact JSON） */
  example: string;
}

/**
 * repair 耗尽时回灌给模型的终止指引：停止重试该工具、换路子或向用户要信息。
 *
 * 不带 hint 时输出与历史上逐字节一致；带 hint 时（N-EXCEL-ARGS-ECHO）额外回显
 * 缺失字段名 + 最小合法调用，并指出：值不知道（比如文件路径）就用
 * Glob/ListDirectory 找，或直接问用户——这两个工具没有可替代的别的工具，
 * "换一条路径"对它们不成立，所以把可执行的下落写明白。
 */
export function buildRepairExhaustedMessage(
  toolName: string,
  attempts: number,
  hint?: RepairExhaustedHint,
): string {
  const lines = [
    `<tool-args-repair-exhausted>`,
    `工具 "${toolName}" 已连续 ${attempts} 次入参校验失败。`,
  ];
  if (hint) {
    if (hint.missingFields.length > 0) {
      lines.push(`The failing calls are missing required field(s): ${hint.missingFields.join(', ')}.`);
    }
    lines.push(`Minimal valid call: ${toolName} ${hint.example}`);
    lines.push(`If a value is unknown (for example the file path), find it with Glob/ListDirectory or ask the user — do not repeat the same call.`);
  }
  lines.push(
    `停止再用同样的方式重试该工具——继续重试只会浪费轮次。请改换策略：`,
    `  - 换一条能达成目标的不同路径（别的工具 / 别的方法）；或`,
    `  - 若确实缺少必要信息，直接向用户说明卡点并询问。`,
    `</tool-args-repair-exhausted>`,
  );
  return lines.join('\n');
}
