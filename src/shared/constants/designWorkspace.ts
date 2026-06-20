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
