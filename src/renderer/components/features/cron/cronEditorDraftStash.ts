// ============================================================================
// 编辑器草稿的「去设置」暂存（N-CRON-WEBHOOK-CLOUD-HOOK-FU1）
// 打开设置页会卸载自动化面板（App.tsx 三元：showSettings 优先于 showCronCenter），
// 编辑器的本地 draft 随之丢失。去配置云端服务前把草稿暂存到模块变量，回来时
// 编辑器重新打开（isEditorOpen 在 cronStore 里不丢）由 effect 取回——用户不必重填整张表单。
// 只在内存，一次性取用。
// ============================================================================
import type { CronJobDraft } from './types';

let stashed: CronJobDraft | null = null;

export function stashCronEditorDraft(draft: CronJobDraft): void {
  stashed = draft;
}

export function takeCronEditorDraft(): CronJobDraft | null {
  const draft = stashed;
  stashed = null;
  return draft;
}
