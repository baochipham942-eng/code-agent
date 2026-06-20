// 设计质量自检（Kun 借鉴：设计 tab 的反 AI 痕迹 PostToolUse 自检）。
// Agent 写/改前端文件后，检测器扫"AI 痕迹"与品味问题，把发现回注给模型
// 让其下一轮自我修正。与 ToolArgsRepairGate（工具入参）是两条独立机制：
// 这条针对"产出的前端代码一眼是 AI 生成"，纯 advisory、不拦截、不报错。
// 详见 docs/competitive/kun-设计tab-借鉴清单.md。
export const DESIGN_QUALITY = {
  // 默认开启（影子模式起步：只报告不拦截，先量误杀率）。
  ENABLED: true,
  // 检测严格度：relaxed 只报最确定 AI 痕迹 / standard 加通用品味 /
  // strict 再加启发式（偶误报）。默认 standard，对齐 Kun 设置页三档。
  STRICTNESS: 'standard',
  // 单次回注给模型的发现条数上限，防 prompt 膨胀。
  MAX_FINDINGS: 12,
  // 跳过病态大文件：行级正则扫描虽便宜，仍需设界。
  MAX_SOURCE_BYTES: 512 * 1024,
  // 触发自检的工具名（写/改前端文件）。
  REVIEW_TOOLS: ['Write', 'Edit', 'MultiEdit'],
} as const;
