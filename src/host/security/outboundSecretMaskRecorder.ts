// ============================================================================
// Outbound Secret Mask Recorder — 掩码替换回执（N-PROMPT-SECRET-MASK-FU2）
// ============================================================================
// 有界内存回执：applyOutboundSecretMask 每次真发生替换时记一条（最近 20 次请求），
// 隐私设置页经只读 IPC 取回展示「哪些种类被换成了什么占位符」。
//
// 红线（owner 拍板 option B）：条目只有 kind + placeholder + 时间 + 可选 provider/model，
// 永远没有原值——原值只存在 outboundSecretMask.ts 的 placeholderToValue 映射里。回执
// 不落盘、不进日志、不进遥测；进程重启即清空（本来就没持久化）。
//
// 形状说明：kind 存占位符里嵌的大写形态（与 {{SECRET_<KIND>_<8hex>}} 一致），展示时
// 无需再变换；placeholder 本身就是可展示的脱敏形态。

/** 一次替换：密钥种类 + 占位符。没有原值，也没有任何原值派生长度/指纹之外的形态。 */
export interface OutboundMaskReplacementRecord {
  readonly kind: string;
  readonly placeholder: string;
}

/** 一次被掩码的请求：时间 + 可选 provider/model + 替换清单。 */
export interface OutboundMaskRequestRecord {
  readonly timestamp: number;
  readonly provider?: string;
  readonly model?: string;
  readonly replacements: readonly OutboundMaskReplacementRecord[];
}

/** 调用方随手可得的请求元信息（model call 侧的 config.provider / config.model）。 */
export interface OutboundMaskRequestMeta {
  readonly provider?: string;
  readonly model?: string;
}

/** 回执容量：只保留最近 20 次被掩码的请求。 */
const MAX_RECORDED_REQUESTS = 20;

const requestRecords: OutboundMaskRequestRecord[] = [];

/**
 * 记一次被掩码的请求。replacements 为空（没发生替换 / 开关关）时是 no-op——回执只
 * 收「真的换了东西」的请求。传入的条目与 meta 都被浅拷贝，调用侧后续改动不影响回执。
 */
export function recordOutboundMaskedRequest(
  replacements: readonly OutboundMaskReplacementRecord[],
  meta?: OutboundMaskRequestMeta,
): void {
  if (replacements.length === 0) return;
  requestRecords.push({
    timestamp: Date.now(),
    ...(meta?.provider ? { provider: meta.provider } : {}),
    ...(meta?.model ? { model: meta.model } : {}),
    replacements: replacements.map((replacement) => ({ ...replacement })),
  });
  if (requestRecords.length > MAX_RECORDED_REQUESTS) {
    requestRecords.splice(0, requestRecords.length - MAX_RECORDED_REQUESTS);
  }
}

/**
 * 只读取回：返回防御性拷贝（消费方改不动内部环形缓冲）。时间序即插入序，最后一项
 * 是最近一次被掩码的请求。
 */
export function getOutboundMaskRecords(): OutboundMaskRequestRecord[] {
  return requestRecords.map((record) => ({
    ...record,
    replacements: record.replacements.map((replacement) => ({ ...replacement })),
  }));
}
