// 设计工作区（Kun 借鉴：设计 tab）运行常量。
export const DESIGN_WORKSPACE = {
  // 原型/设计产物在工作目录下的输出子目录。
  OUTPUT_DIR: '.neo-design',
  // 预览轮询间隔与总超时（Agent 增量写文件，边长边刷预览）。
  // 间隔取较密（500ms）让预览更接近"边长边显"的实时效果。
  POLL_INTERVAL_MS: 500,
  POLL_TIMEOUT_MS: 120_000,
  // 完成判定：内容大小连续 N 轮不变才算稳定（N×间隔 ≈ 静默窗口）。
  // 不能一看到 </html> 就停——Agent 先写的骨架已含 </html>，会冻结在骨架；
  // 且骨架→edit 之间 MiMo 有思考停顿，窗口太短会在停顿处误判完成。取 12（≈10s）
  // 扛过停顿，中途每次变化都刷新预览，最终吃到完整页面（dogfood 实测）。
  STABLE_ROUNDS: 12,
  // 设计草稿工作目录的路径标记：用于把设计会话从聊天侧栏过滤掉（设计草稿不该当成
  // 聊天项目占侧栏；设计模式有自己的历史）。与主进程 getUserConfigDir()/design 对应。
  DRAFT_PATH_MARKER: '/.code-agent/design/',
  // 画布（Cowart 式）：图片产物子目录、新节点间距、回灌后兜底节点尺寸。
  CANVAS_ASSETS_DIR: 'assets',
  CANVAS_NODE_GAP: 60,
  CANVAS_NODE_FALLBACK_SIZE: 512,
} as const;

/**
 * 预览设备断点预设（桌面/平板/手机）。`width=null` 表示自适应满宽（桌面）；
 * 平板/手机给出固定 CSS 像素宽，预览 iframe 据此收窄并居中，模拟响应式断点。
 */
export const DESIGN_DEVICE_PRESETS = [
  { id: 'desktop', width: null },
  { id: 'tablet', width: 768 },
  { id: 'mobile', width: 375 },
] as const;

export type DesignDeviceId = (typeof DESIGN_DEVICE_PRESETS)[number]['id'];

/** 原型版本快照存放的子目录（在每个 run 目录下）。每次生成/续编完成快照一份。 */
export const DESIGN_VERSIONS_SUBDIR = 'versions';

/** variant spine 落盘文件名（每个 run 目录一份，持有 proto 版本的 pin/discard 状态）。 */
export const DESIGN_SPINE_FILE = 'spine.json';

/**
 * 一致性锁定再编辑（T4）：局部重绘后校验"未选区域逐像素不变"的参数。
 * wanx2.1-imageedit 等扩散 inpaint 会系统性地轻微改写 mask 外区域（全局重压缩/色偏），
 * 故 diff-gate 度量未选区漂移，越界即触发 region-lock 把原图未选区贴回保证逐像素一致。
 */
export const REGION_LOCK = {
  // 未选区域单像素通道差容差（0-255）。≤ 该值视为"未变"。语义=逐像素逐通道绝对差上界
  // （非 CIEDE2000 感知色差）；8/255≈3%，足以滤掉 inpaint 重压缩噪声又能抓住肉眼可见漂移。
  EPSILON: 8,
  // diff 证据图相对原产物的文件名后缀（同目录落盘）。
  DIFF_SUFFIX: '.diff.png',
} as const;
