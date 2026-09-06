# Ship Note — feat/ink-tui-ux-p1（neo CLI 交互体验第一批 P1）

> 日期：2026-08-30 · 分支：feat/ink-tui-ux-p1（2 commits，基于 feat/ink-shell-passthrough）
> 依据：docs/competitive/grok-codex-借鉴清单.md P1 项 B5→A / A5 / A3 / Ctrl+Q / Ctrl+R

## 范围

P1（高频体感）：

1. **`/ps` `/stop` 后台任务 UX（B5→A）**：机制（backgroundTasks 上限 10/10min/1MB
   + Process 工具 + shutdownReaper）本已是一等公民，本批只做 CLI 呈现与控制——
   `/ps` 列表（状态/耗时/exit code/命令，新的在前）、`/stop <id 或唯一前缀>` 终止
   （歧义/无匹配/已结束均有明确文案）；StatusBar 新增运行中后台任务计数分段
   （◉N bg）；任务完成/失败落系统消息。
2. **终端通知（A5）**：turn 结束 / 审批卡出现 / 后台任务完成或失败时发 OSC 9
   （iTerm2/WezTerm/ghostty/vscode/kitty），不支持的终端回退 BEL；DECSET 1004
   焦点上报，**失焦才发**——语义对齐桌面端 osNotification.ts 的
   shouldSuppressOsNotification（聚焦 = 用户正盯着，通知只打扰不传信）；
   消息剥控制字符防 OSC 注入；`NEO_DISABLE_TERMINAL_NOTIFY=1` 逃生门。
3. **审批卡扩充（A3 + codex 漏判补充）**：选项扩为 Allow once /
   Allow all edits this session（仅编辑类）/ Always allow: X / Never allow: X /
   No, reject / No, reject with feedback（数字直选 1-9）；never 会话级拒批，
   命中直接拒（denialSource=user）不再弹卡；附反馈经 PermissionAskResult.message
   回传 agent；edit_file 审批展示 `+N -M lines` 变更摘要，Tab 展开 inline diff
   （- 红 / + 绿，超 8 行截断），write_file 展示字节数摘要。
4. **Ctrl+Q 双击确认退出**（1000ms 窗口防误触，首次 toast 提示）；
   **Ctrl+R prompt 历史搜索**（子串过滤新的在前，Ctrl+R/↑↓ 翻匹配，
   Enter 采纳进编辑器，Esc 恢复草稿）。

附修（pty 实测发现）：附反馈与历史搜索的 Enter 在末字符合批 chunk（如 `y\r`）
下被吞——`\r` 一律视为提交/采纳，前置可打印字符并入缓冲。

## 验证证据

- **全量**：`npx vitest run` 22073 passed / 0 failed（2573 文件全绿）@ 13eacccac
- **质量门**：typecheck 0 错；`npm run build:cli` 成功；eslint 改动文件 0 告警；
  knip 三门全过
- **新单测**：approval 扩充（选项组合/摘要/diff/never/allEdits 12 例）、
  terminalNotification（门控/OSC9/BEL/注入剥离 8 例）、PromptHistory.search（4 例）、
  /ps /stop 命令（6 例）；既有 approval 契约同步更新
- **pty 端到端**（/tmp/neo-p1-sandbox，CODE_AGENT_DATA_DIR 隔离空配置规避本机
  exec-policy allow 短路）：`/ps` 空列表；`!git reset --hard` 确定性弹审批卡、
  选项含 Never allow / reject with feedback；数字直选附反馈模式输 feedback 拒绝
  收口（命令未执行）；Ctrl+R 搜中 `/ps` 并采纳；Ctrl+Q 双击 exit 0。
  脚本 `/tmp/neo-p1-sandbox/pty_ux_p1.py`
- **非 TTY 回归**：`(sleep 5; printf '/exit\n') | node dist/cli/index.cjs` exit 0

## 偏差与遗留

- OSC 9 支持名单保守（5 个终端），其余回退 BEL；不支持焦点上报的终端按
  "始终聚焦"处理（不发通知，宁缺毋扰）
- 后台任务完成通知依赖同进程 lifecycle 事件；CLI 退出后完成的任务不补发
- edit_file inline diff 为 old/new 块级展示（edit 参数即完整替换段），未做 LCS
- 审批卡 expanded diff 行预算 20 行（超出由布局裁剪），小终端按 rows-6 收顶
