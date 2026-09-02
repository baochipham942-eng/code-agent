// 用户在 agent 运行过程中插话的两档指令（主输入框 Enter/⌘Enter 与成员视图同一套话）。
// 主 run 由 workbenchTurnContext 按轮注入；给成员补话时直接拼进投递文本，因为子代理执行器
// 只在两轮之间抽干收件箱、没有 turnSystemContext 通道。

export const RUNTIME_INPUT_SUPPLEMENT_LINE =
  '这条消息是用户在 agent 运行过程中的补充指令：把它纳入当前任务和已有计划，除非内容明确要求改方向，不要把它当成全新任务。';

export const RUNTIME_INPUT_REDIRECT_LINE =
  '这条消息是用户显式选择的改道指令：停止沿用当前思路，按这条新要求重组接下来的执行。';
