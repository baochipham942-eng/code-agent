// ============================================================================
// knipProductionAnchor — 生产可达性门的锚点夹具（不是业务代码，零依赖零导出）
// ============================================================================
//
// 这个文件存在的唯一意义：作为 scripts/knip-production-ratchet.mjs 的 ANCHOR——一个
// "已知必然生产不可达"的文件，用来证明该门的口径仍然有效。它若从 knip 的不可达名单里
// 消失而文件还在，说明配置 / entry / 报告格式漂了，门必须报红而不是"零命中=通过"假绿。
// （前任锚点 src/host/errors/recoveryEngine.ts 是 Electron 时代错误恢复引擎的真实现，
// 2026-10 孤儿清理工单删除真实现时，把锚点换到这个专用夹具上。）
//
// 🔴 禁止 import 本文件（生产、测试、脚本都不行）：任何消费方都会让它变成"可达"，
//    锚点检查（parseKnipResult 的 existsSync 守卫分支）随之报红。
// 🔴 若确需删除本文件，必须在同一提交里改 scripts/knip-production-ratchet.mjs 的
//    ANCHOR 常量与 tests/scripts/knipProductionRatchet.test.ts 的锚点存在性断言——
//    2026-08-14 已踩过一次"静默失锚、ratchet 照样打 ✓"的坑，别再踩。
