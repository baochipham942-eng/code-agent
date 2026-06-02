// 临时验证脚本：聊天输入框的 skill 推荐条（已安装挂载 / 未安装导购）
// 用法: node scripts/claude-e2e/verify-chat-skill-recommend.mjs [port]
import { chromium } from '@playwright/test';

const port = process.argv[2] || '8287';
const baseUrl = `http://127.0.0.1:${port}`;
const shotDir = '/tmp/neo-chat-recommend-verify';

// 用系统 Chrome，避免依赖 playwright 浏览器下载
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

try {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${shotDir}/01-app-loaded.png` });

  // 找到聊天输入框（textarea 或 contenteditable）
  const input = page.locator('textarea').first();
  const inputVisible = await input.isVisible().catch(() => false);
  if (!inputVisible) {
    console.log('WARN: 没找到 textarea，尝试 contenteditable');
  }

  // 输入命中 pptx 关键词的文本
  await input.click();
  await input.fill('帮我做个PPT汇报，下周一要用');
  // 等待防抖(500ms) + IPC 往返
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${shotDir}/02-after-typing.png` });

  // 检查推荐条
  const checks = {
    安装芯片出现: await page.getByText('安装', { exact: true }).first().isVisible().catch(() => false),
    PPT演示文稿推荐: await page.getByText('PPT 演示文稿').first().isVisible().catch(() => false),
  };

  // 再试一个营销文案场景
  await input.fill('帮我写个营销文案，落地页用的');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${shotDir}/03-marketing-input.png` });
  checks['营销文案推荐'] = await page.getByText('营销文案').first().isVisible().catch(() => false);

  // 清空输入，推荐条应消失
  await input.fill('');
  await page.waitForTimeout(1000);
  checks['清空后推荐消失'] = !(await page.getByText('PPT 演示文稿').first().isVisible().catch(() => false));
  await page.screenshot({ path: `${shotDir}/04-cleared.png` });

  console.log('CHAT RECOMMEND CHECKS:', JSON.stringify(checks, null, 2));
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
