# 极客时间课程差距修复计划

> 创建日期：2026-06-02
> 依据报告：[docs/research/2026-06-02-geektime-course-gap-analysis.md](../research/2026-06-02-geektime-course-gap-analysis.md)
> 状态：已确认（阶段 1-3 原案通过；阶段 4 按修正版执行——skill 自动蒸馏降级为半自动确认制）

## 阶段总览

| 阶段 | 主题 | 包含 GAP | 分支 | 状态 |
|------|------|---------|------|------|
| 一 | 拆假护栏（安全） | 002, 001, 007, 003 | `fix/geektime-gap-phase1-guardrails` | IN PROGRESS |
| 二 | 上下文经济 | 008, 009, 010 | `feat/geektime-gap-phase2-context-economy` | PENDING |
| 三 | 质量闭环 | 006+014, 013, 004, 016, 012+015 | `feat/geektime-gap-phase3-quality-loops` | PENDING |
| 四 | 经验沉淀（修正版） | 005(仅 Failure Journal + 半自动 skill 草稿), 011, 017 | `feat/geektime-gap-phase4-experience` | PENDING |
| 出局 | — | 018(等阶段三基建), 019, 020, 021, 022 | — | WONT_DO（现阶段） |

## 排序逻辑

作者四方向（安全/上下文经济/质量/经验沉淀）+ 修复型排序：假护栏（以为有保护实际没有）风险最高且改动最小，先拆；成本回归每天都在烧钱，次之；质量闭环是结构性改进；经验沉淀是 feature 级投入，最后。

## 执行约定

1. 每阶段一个分支、一个 PR；阶段内每个 GAP 完成立即 commit（不积攒）
2. 每个功能点：修改 → `npm run typecheck` → 测试 → commit
3. 每阶段结束跑 E2E 验收（见各阶段验收标准）+ eval 对比留档
4. 不主动 push / 不开 PR，由林晨确认后操作

## 阶段一验收标准（拆假护栏）

- [ ] 红队 case：只读 skill（allowed-tools 只有 Read/Grep）在 inline 模式调用 Write/Bash 被拦截
- [ ] policy.toml 写 denied_path 后，Edit 该路径被硬拦，DecisionTrace 出现 policy_enforcer 层
- [ ] 配置文件写未知字段（如 `alowed-tools` typo），日志出现 warning
- [ ] 同一会话跑 10 轮，AI SDK 路径的 API 返回 cache_read_input_tokens > 0

## 阶段二验收标准（上下文经济）

- [ ] 接入 ≥2 个 MCP server 后，系统提示词中 MCP 工具只有名字索引，schema 按需加载
- [ ] 工具输出超阈值时落盘到 session 临时目录，上下文只留摘要+路径，agent 可用 Read 回查
- [ ] env block 包含当前分支、最近 commit、working tree dirty 状态

## 阶段三验收标准（质量闭环）

- [ ] Stop hook 返回 block 时 agent 继续工作（最多重试 1 次的安全阀生效）
- [ ] PostToolUse hook 的输出能注入下一轮上下文（写文件 → lint 失败 → agent 自动修）
- [ ] workflow stage 失败达到 maxRetries 后走回退路由而非死循环；circuit breaker 跳闸通知用户
- [ ] MiMo text-first 死循环 case 复现测试通过（不再卡死）

## 阶段四验收标准（经验沉淀，修正版）

- [ ] 同一错误模式出现 ≥3 次后，Light Memory 出现 failure journal 条目
- [ ] 下一个 session 遇到同类操作时，journal 条目被注入上下文且 agent 未重复踩坑（eval 可测）
- [ ] 重复成功模式 ≥3 次后生成 skill 草稿并弹用户确认（不自动入库）
- [ ] 评测中心支持固定模型、变 harness 配置的对照实验

## 进度日志

| 日期 | 进展 |
|------|------|
| 2026-06-02 | 计划确认，阶段一开工 |
