import { type Page } from '@playwright/test';

// 全新 e2e 数据目录 = 全新机器，首启动会弹「信任这个项目文件夹？」和「初始化 Neo」引导。
// 引导弹层盖住整个界面，底下的 UI 一律不可达 —— 不点掉它，任何剧本的第一个 locator 都会超时，
// 红点落在引导上而不是被验收的功能上（2026-08-17 实测：三个剧本 5 个用例全卡在找不到「新会话」）。
// 点「跳过」的效果不落盘，每次 page.goto('/') 之后都要重来一遍。
//
// 2026-08-18 实测补一条时序（N-E2E-CONTRACT）：「初始化 Neo」不是随页面一起出现的——
// App.tsx 的 openModelOnboardingIfNeeded 在挂载后 UI.STARTUP_API_KEY_CHECK_DELAY（1.5s）
// 才跑，且它先看登录态（未登录走 AuthModal，已登录才弹 ModelOnboardingModal）。
// web e2e 是**自动登录**的（侧栏显示 Local Web Test User / 管理员），所以走的是后者：
// 全新数据目录下弹层约在 t≈3s 才盖上来，t≈1s 时 DOM 里还什么都没有。
// ⇒ 只在开头点一次是有竞态的：先跑完的断言侥幸绿，之后的被盖住。
// 真正的兜底是 seedE2eSettings.ts 的「已过引导」固件（onboarding.completedAt 有值 ⇒
// 上面那个函数直接 return，弹层从源头不出现）；本 helper 留着管「信任这个项目文件夹？」，
// 以及别人手工起 server（没走 playwright config、没落固件）时的防御。
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
