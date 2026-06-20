// 设计工作区（Kun 借鉴：设计 tab）运行常量。
export const DESIGN_WORKSPACE = {
  // 原型/设计产物在工作目录下的输出子目录。
  OUTPUT_DIR: '.neo-design',
  // 预览轮询间隔与总超时（Agent 增量写文件，边长边刷预览）。
  POLL_INTERVAL_MS: 800,
  POLL_TIMEOUT_MS: 120_000,
  // 完成判定：内容大小连续 N 轮不变才算稳定（N×间隔 ≈ 静默窗口）。
  // 不能一看到 </html> 就停——Agent 先写的骨架已含 </html>，会冻结在骨架；
  // 且骨架→edit 之间 MiMo 有思考停顿，窗口太短会在停顿处误判完成。取 12（≈10s）
  // 扛过停顿，中途每次变化都刷新预览，最终吃到完整页面（dogfood 实测）。
  STABLE_ROUNDS: 12,
} as const;
