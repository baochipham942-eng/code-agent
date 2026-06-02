// 临时验证脚本：Skills 设置页「发现安装」Tab 的推荐分类 + 角色场景包 UI
// 用法: node scripts/claude-e2e/verify-skills-discover.mjs [port]
import { chromium } from '@playwright/test';

const port = process.argv[2] || '8285';
const baseUrl = `http://127.0.0.1:${port}`;
const shotDir = '/tmp/neo-skills-verify';

// 用系统 Chrome，避免依赖 playwright 浏览器下载
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

try {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${shotDir}/01-app-loaded.png` });

  // 打开设置：点击侧边栏底部用户菜单（"Local Web T..." 区域）→ 设置
  const settingsOpened = await (async () => {
    const userMenu = page.getByText('Local Web T', { exact: false }).first();
    if (await userMenu.isVisible().catch(() => false)) {
      await userMenu.click();
      await page.waitForTimeout(600);
      const settingsItem = page.getByText('设置', { exact: true }).first();
      if (await settingsItem.isVisible().catch(() => false)) {
        await settingsItem.click();
        return true;
      }
    }
    return false;
  })();

  await page.waitForTimeout(800);
  await page.screenshot({ path: `${shotDir}/02-after-open-settings.png` });
  if (!settingsOpened) {
    console.log('WARN: 没找到设置入口，看 02 截图确认页面状态');
  }

  // 点击 Skills tab
  const skillsTab = page.getByText('Skills', { exact: true }).first();
  await skillsTab.click({ timeout: 5000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${shotDir}/03-skills-tab.png` });

  // 点击 发现安装
  const discoverTab = page.getByText('发现安装', { exact: true }).first();
  await discoverTab.click({ timeout: 5000 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${shotDir}/04-discover-top.png` });

  // 验证关键元素存在
  const checks = {
    角色场景包: await page.getByText('角色场景包').isVisible().catch(() => false),
    产品经理包: await page.getByText('产品经理包').isVisible().catch(() => false),
    按场景浏览: await page.getByText('按场景浏览').isVisible().catch(() => false),
    文档办公: await page.getByText('文档办公', { exact: true }).isVisible().catch(() => false),
    PPT演示文稿: await page.getByText('PPT 演示文稿').first().isVisible().catch(() => false),
    整库安装: await page.getByText('整库安装').isVisible().catch(() => false),
  };
  console.log('ELEMENT CHECKS:', JSON.stringify(checks, null, 2));

  // 滚动截全发现安装 tab 的内容
  const modal = page.locator('[class*="overflow-y-auto"]').last();
  await modal.evaluate((el) => el.scrollTo(0, el.scrollHeight / 3)).catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${shotDir}/05-discover-categories.png` });

  await modal.evaluate((el) => el.scrollTo(0, el.scrollHeight)).catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${shotDir}/06-discover-bottom.png` });

  const allPassed = Object.values(checks).every(Boolean);
  console.log(allPassed ? 'VERIFY: ALL PASSED' : 'VERIFY: SOME CHECKS FAILED');
  process.exitCode = allPassed ? 0 : 1;
} catch (err) {
  console.error('VERIFY ERROR:', err.message);
  await page.screenshot({ path: `${shotDir}/99-error.png` }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
