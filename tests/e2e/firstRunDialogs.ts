import { type Page } from '@playwright/test';

// 全新 e2e 数据目录 = 全新机器，首启动会弹「信任这个项目文件夹？」和「初始化 Neo」引导。
// 引导弹层盖住整个界面，底下的 UI 一律不可达 —— 不点掉它，任何剧本的第一个 locator 都会超时，
// 红点落在引导上而不是被验收的功能上（2026-08-17 实测：三个剧本 5 个用例全卡在找不到「新会话」）。
// 点「跳过」的效果不落盘，每次 page.goto('/') 之后都要重来一遍。
//
// 这段逻辑此前在 9 个 spec 里各存一份（voice-ux-display / goal-mode / slash-commands …），
// 第 10 份起收在这里；存量那 9 份不动（改它们不在本单范围内）。
export async function dismissFirstRunDialogs(page: Page): Promise<void> {
  const trustDialog = page.getByRole('dialog', { name: '信任这个项目文件夹？' });
  await trustDialog.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
  if (await trustDialog.isVisible().catch(() => false)) {
    await trustDialog.getByRole('button', { name: '阻止项目配置' }).click();
  }
  const onboarding = page.getByRole('dialog', { name: '初始化 Neo' });
  await onboarding.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
  if (await onboarding.isVisible().catch(() => false)) {
    await onboarding.getByRole('button', { name: '跳过，稍后在设置里配置' }).click();
  }
}
