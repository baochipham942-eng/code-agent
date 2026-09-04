import { type Page } from '@playwright/test';

// 全新 e2e 数据目录 = 全新机器，首启动会弹「初始化 Neo」引导（2026-09-04 N-FIRSTRUN-SKIP 起：
// 「跳过」直接落主界面、只留一条提示条不遮挡；文件夹信任弹窗改成只在会话绑到带自动化配置的
// 文件夹时才问，无会话冷启动不再弹——下面对它的处理只是兜底）。
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
// 曾经有过一个「已过引导」固件（seedE2eSettings，从源头让弹层不出现），
// 但它的反向变异两轮都没红、拿不出承重证据，2026-08-19 由产品负责人拍板撤除
// ——退役理由与「什么信号出现时该加回来」写在 playwright.e2e.config.ts 的退役标注里。
// ⇒ 现在**这个 helper 就是唯一的处理路径**：点掉已经弹出来的层，
//   并且它本身带竞态（弹层 t≈3s 才盖上来，开头点一次点不到后来的）。
//   剧本若在开头 3 秒内断言并成片报「找不到元素/被遮挡」，先怀疑这个竞态。
//
// 这段逻辑此前在 9 个 spec 里各存一份（voice-ux-display / goal-mode / slash-commands …），
// 第 10 份起收在这里；存量那 9 份不动（改它们不在本单范围内）。
export async function dismissFirstRunDialogs(page: Page): Promise<void> {
  const trustDialog = page.getByRole('dialog', { name: '这个文件夹带了自动化配置，要启用吗？' });
  await trustDialog.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
  if (await trustDialog.isVisible().catch(() => false)) {
    await trustDialog.getByRole('button', { name: '先不启用' }).click();
  }
  const onboarding = page.getByRole('dialog', { name: '初始化 Neo' });
  await onboarding.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
  if (await onboarding.isVisible().catch(() => false)) {
    await onboarding.getByRole('button', { name: '跳过，稍后在设置里配置' }).click();
  }
}
