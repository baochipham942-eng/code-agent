# Ship Note — feat/ink-tui（Ink TUI + headless 加固）

> 日期：2026-08-30 · 分支：feat/ink-tui（4 commits，基点 origin/main 92e64ba1d）

## 范围

1. **cbbe0156** `feat(cli)`：bare `neo` 默认进交互式 chat；CLI 模式 ERROR 日志紧凑单行（完整堆栈留日志文件）；console.error 走 TUI 滚动区
2. **975a8bec** `feat(cli)`：Ink（React）全屏 TUI 替换 readline/手写 ANSI 双实现。交互规格参照 Grok Build（`docs/design/2026-08-29-ink-tui-grok-interaction-spec.md`）：braille spinner 7.5fps / 空闲呼吸 ◆ / thinking 折叠 `Thought for Xs` / 工具归组 `Read 3 files` / 多行编辑器 / 粘贴 chip / slash 模糊菜单（接真命令注册表）/ 运行中排队 / Esc·Ctrl+C 分层中断。esbuild 侧 `inkCjsCompatPlugin`（yoga TLA 垫片 + ink DEV 分支剔除）保住单文件 cjs 分发；`NEO_DISABLE_INK_TUI=1` 逃生门
3. **9f79f995** `fix(skills)`：depends/provides 缺省宽容化（`[]` / `[skill:<name>]`），capability 注册与库扫描改 per-skill/per-library 隔离——修复 191 个 legacy skill 无法注册、一个坏库拖垮全库扫描
4. **3fab48969** `fix(agent)`：MemoryWrite 确认窗 headless fail-fast（web 无 SSE 10s 探针竞速；桌面 120s 确认窗不变；skip 放行写 permission ledger）；tool_result 密钥脱敏收口（transcript/导出/事件流）；toolCallId 重复去重护栏（修结果路由串线）；MCP 只读 action 免确认；模型调用瞬断 5 次指数退避重试（非流式 honor disableProviderTransientRetry）；run 失败保留部分成果

## 验证证据

- **全量**：`npx vitest run` 21879 passed / 1 failed（`agentOrchestrator` 语音入口链 30s 超时，负载抖动假红——同一文件在 origin/main 与 feat/ink-tui 单独跑均 58/58 通过，失败集 ⊆ 基线 flaky 集）@ 3fab48969
- **质量门**：typecheck 0 错、`npm run build` 全量四产物成功、eslint 0 新增告警、knip 依赖门通过；pre-commit 模型名新鲜度检查逐次通过
- **端到端**（custom-tokenrhythm/glm-5.3-flash，沙箱 /tmp/neo-verify）：11 场景矩阵（多轮/search/plan/AskUserQuestion/permission/产物/skill/mcp/memory/subagent/agent team）；MemoryWrite headless 21ms fail-fast + skip 放行落账本；504 重试 3 次成功（fake 网关实测）；真实模型密钥脱敏后导出零明文；MCPUnified status 只读放行
- **三端**：CLI/web/desktop 逐 fix 行为矩阵审计（见会话记录）；web E2E 无 SSE fail-fast / 有 SSE 确认窗原路径；桌面 Electron 确认窗路径零改动

## 偏差与遗留

- Ink `<Static>` 方案下 StatusBar 未钉物理顶行（Ink v7 裁剪缺陷，后续自实现测量裁剪）
- 权限审批卡片（allow once/always/deny）未做，为下一期独立项
- 规格中 Esc 双击 rewind、Ctrl+Q 双击退出、窄终端 compact 策略未实现
- 存量含重复 toolCallId 的旧会话导出仍 last-write-wins（源头已堵）；citation 引用片段边缘路径未脱敏
- web 无人值守会话 MemoryWrite 语义与桌面不完全一致（10s fail-fast vs 120s 窗口），各自可辩护，未强行拉齐
- 观测缺口（未修，记录在案）：日志行无 sessionId 字段；session timeline 的 Telemetry turns 恒为 0
