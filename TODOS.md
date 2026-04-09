# TODOS

## Agent Core

### Light Memory 清理旧 vector/embedding 代码

**What:** 删除已废弃的 HybridSearch/RRF/entity_relations 旧记忆系统代码（~13K 行）
**Why:** 降低维护负担，新 Light Memory（~553 行）已完全替代
**Context:** 旧系统在 v0.16.x 已停用，前端面板已适配新系统
**Effort:** S
**Priority:** P2
**Depends on:** 确认 Light Memory 稳定运行 2 周+

## 评测

### 增量修改场景评测用例

**What:** 针对 P0 问题构建专项 Eval Set — 多轮对话中的文件读取→修改→再修改链路
**Why:** 没有评测就无法量化修复效果，避免"修了又回归"
**Context:** 已有咖啡店 GUI 测试 case 可作为种子，需要扩充到 5+ 场景
**Effort:** M
**Priority:** P1
**Depends on:** 无

## Completed

### 修复 Observation Masking 导致的工具调用失控 ✅ 2026-03-20

**What:** 多轮对话中 observationMask 清除 Read 结果后，模型用 Bash 反复读文件，触发 51 次工具调用死循环
**Resolution:** commit `c8a8db1d` — 4 层防御落地
1. L1 止血：Placeholder 文本改为不指示重读
2. L2 推迟：压缩阈值 0.6→0.75，PRESERVE_RECENT 6→10
3. L3 检测：AntiPatternDetector 新增 trackFileReread，3+ 次触发警告
4. L4 根治：智能 Masking 保护活跃文件最后一次 Read 结果
**Files:** `src/shared/constants/agent.ts`、`src/main/context/{autoCompressor,tokenOptimizer}.ts`、`src/main/agent/antiPattern/detector.ts`
**Verification:** 预期工具调用从 51 降到 <15，需长对话场景验证效果
