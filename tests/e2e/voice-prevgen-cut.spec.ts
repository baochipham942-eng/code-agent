// ============================================================================
// N-L7-PREVGEN-MUTE — 通话入口只保留 3.5 系
// Web Server 模式验证设置页真实挂载结果；存量拨号回落由 host 单测与 Dev 槽事件流验证。
// ============================================================================

import { test, expect, type Page } from '@playwright/test';

test.setTimeout(60_000);

async function dismissProjectTrust(page: Page) {
  const trustDialog = page.getByRole('dialog', { name: '信任这个项目文件夹？' });
  await trustDialog.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
  if (await trustDialog.isVisible().catch(() => false)) {
    await trustDialog.getByRole('button', { name: '阻止项目配置' }).click();
    await expect(trustDialog).toBeHidden();
  }
}

async function openVoiceModelSettings(page: Page) {
  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });
  // 真机存量会话可能先触发项目级配置的信任弹窗；本用例不消费项目配置，明确阻止即可。
  // 若不先处理，它的遮罩会盖住稍后出现的 onboarding，Playwright 会一直等点击落下。
  await dismissProjectTrust(page);

  const onboarding = page.getByRole('dialog', { name: '初始化 Neo' });
  // 首启检查在 App mount 后延迟 1.5s 执行，不能用一次即时 isVisible 判定，
  // 否则会先打开设置，再被稍后挂载的 onboarding 盖住。
  await onboarding.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
  if (await onboarding.isVisible().catch(() => false)) {
    await dismissProjectTrust(page);
    await onboarding.getByRole('button', { name: '跳过，稍后在设置里配置' }).click();
    await expect(onboarding).toBeHidden();
  } else {
    await page.getByRole('button', { name: '用户菜单' }).click();
    await page.getByRole('button', { name: '设置', exact: true }).click();
  }

  const settingsDialog = page.getByRole('dialog', { name: '设置' });
  await expect(settingsDialog).toBeVisible({ timeout: 10_000 });
  await settingsDialog.getByRole('button', { name: '语音模型', exact: true }).click();
  await expect(settingsDialog.getByTestId('voice-model-settings')).toBeVisible({ timeout: 10_000 });
  return settingsDialog;
}

test('通话模型与音色只展示 3.5 系白名单', async ({ page }, testInfo) => {
  const dialog = await openVoiceModelSettings(page);
  const modelSelect = dialog.getByTestId('voice-conversation-model');

  await expect(modelSelect.locator('option')).toHaveCount(1);
  await expect(modelSelect.locator('option')).toHaveText(['Qwen3.5 Omni Flash Realtime']);
  await expect(dialog.getByTestId('voice-model-voice-list')).toContainText('Tina');
  await expect(dialog.getByTestId('voice-model-voice-list')).toContainText('Ethan');
  await expect(dialog.getByTestId('voice-model-voice-list')).toContainText('Serena');
  await expect(dialog.getByTestId('voice-model-voice-list')).toContainText('普通话·甜暖');
  await expect(dialog.getByTestId('voice-model-voice-list')).toContainText('普通话·明亮朝气');
  await expect(dialog.getByTestId('voice-model-voice-list')).toContainText('女声·温柔');
  await expect(dialog.getByTestId('voice-model-voice-list')).not.toContainText('Cherry');
  await expect(dialog.getByTestId('voice-model-voice-list')).not.toContainText('Chelsie');

  await page.screenshot({ path: testInfo.outputPath('voice-prevgen-cut.png'), fullPage: false });
});
