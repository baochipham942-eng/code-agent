# N-DELIVCARD 证据档

## 证据档位

- Hermetic：完成。
- Real-runtime：未运行。按工单约束，Dev 槽和任何 `~/.code-agent*` 均未触碰；由编排会话（劳拉）收活后执行。

## 改动

- `src/renderer/utils/artifactOwnership.ts:115`：文件同时出现在本轮 diff 时，仅丢弃非 `deliverable` 条目；保留现有 path 去重。
- `src/renderer/components/features/chat/TurnCard.tsx:150-158,541-555`：按 deliverable file path 把 `FileChange` 送进产物卡，并从轮级 `TurnDiffSummary` 排除该 path。
- `src/renderer/components/features/chat/TraceNodeRenderer.tsx:40-55,503-504,770-812`：把本轮的交付物变更信息传到文件产物渲染。
- `src/renderer/components/features/chat/MessageBubble/FileArtifactCard.tsx:36-73,179-193`：产物卡内显示“本次变更 +N 行/-N 行”，可展开 `DiffView`。
- `src/renderer/components/features/chat/MessageBubble/DeliverableCardList.tsx:32-35,139-147`：支持卡内的次要详情插槽。
- 后端未改动。

## Hermetic 验收

- `tests/renderer/utils/artifactRole.redlines.test.ts`：deliverable 文件与同轮 diff 共存时仍产出；非 deliverable 同路径仍丢弃；只读 `read` 即使带错误 deliverable 标记也不上产物区。
- `tests/renderer/components/turnDiffSummary.expansion.test.tsx`：已由产物卡接管的 path 不再渲染轮级 diff 卡。
- `tests/renderer/components/traceSourcesQuiet.test.tsx`：交付文件卡显示次要变更量入口。
- 最终相关全量 hermetic 批次：19 test files，98 passed / 0 failed / 0 skipped。
- `npm run typecheck`：通过。
- `node scripts/tsc-tests-ratchet.mjs`：current=0 / baseline=0 / delta=0，通过。
- `node scripts/check-design-system.mjs`：通过。
- `node scripts/eslint-ratchet.mjs`：通过。
- `git diff --check`：通过。
- 提交：未完成。`git add && git commit` 尝试创建共享 worktree 索引
  `/Users/linchen/Downloads/ai/code-agent/.git/worktrees/code-agent-wt-delivcard/index.lock`
  时被沙箱拒绝（`EPERM`）；未使用任何绕过方式。

## 反向变异

临时将 `artifactOwnership.ts:115` 还原为不区分 role 的旧条件。核心用例 `deliverable 文件即使同轮有 diff，仍进入产物条目` 由绿转红：收到 `[]`，期望包含 `/repo/app/neo-intro.html`。变异后已还原最终代码，再次相关全量 hermetic 批次为 98 passed / 0 failed / 0 skipped。

## 编排会话的 real-runtime 验收口径

让 Neo 用 Write 创建 `neo-intro.html`。预期：

1. 聊天流在最终答案后先显示 `neo-intro.html` 的产物卡，卡内有次要的“本次变更 +243 行”入口；展开入口可看到该文件的 diff。
2. 同一文件不再额外显示“已编辑 1 个文件”的轮级 diff 卡。
3. 同轮的非 deliverable 代码编辑仍保留原有独立轮级 diff 卡，能展开 diff 与执行既有 Undo 流程。
4. Read/Glob/Grep 等只读工具的路径不进入产物区。
