// 临时验证脚本：MCP 设置页「发现连接」Tab + 插件管理瘦身后布局
// 用法: node scripts/claude-e2e/verify-mcp-plugins.mjs [port]
import { chromium } from '@playwright/test';

const port = process.argv[2] || '8286';
const baseUrl = `http://127.0.0.1:${port}`;
const shotDir = '/tmp/neo-mcp-plugins-verify';

// 用系统 Chrome，避免依赖 playwright 浏览器下载
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

try {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${shotDir}/01-app-loaded.png` });

  // 打开设置：侧边栏底部用户菜单 → 设置
  const userMenu = page.getByText('Local Web T', { exact: false }).first();
  await userMenu.click();
  await page.waitForTimeout(600);
  await page.getByText('设置', { exact: true }).first().click();
  await page.waitForTimeout(800);

  // ===== MCP 页 =====
  await page.getByText('MCP', { exact: true }).first().click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${shotDir}/02-mcp-connected.png` });

  // 切到发现连接
  await page.getByText('发现连接', { exact: true }).first().click();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${shotDir}/03-mcp-discover-top.png` });

  const mcpChecks = {
    按用途浏览: await page.getByText('按用途浏览').isVisible().catch(() => false),
    搜索与抓取: await page.getByText('搜索与抓取', { exact: true }).isVisible().catch(() => false),
    办公协作: await page.getByText('办公协作', { exact: true }).isVisible().catch(() => false),
    飞书: await page.getByText('飞书', { exact: true }).first().isVisible().catch(() => false),
    Notion: await page.getByText('Notion', { exact: true }).first().isVisible().catch(() => false),
    国内直连标签: await page.getByText('国内直连').first().isVisible().catch(() => false),
  };
  console.log('MCP CHECKS:', JSON.stringify(mcpChecks, null, 2));

  // 滚动看中下部分类
  const modal = page.locator('[class*="overflow-y-auto"]').last();
  await modal.evaluate((el) => el.scrollTo(0, el.scrollHeight)).catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${shotDir}/04-mcp-discover-bottom.png` });

  // ===== 插件管理页 =====
  await page.getByText('插件管理', { exact: true }).first().click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${shotDir}/05-plugins-top.png` });

  const pluginChecks = {
    已安装插件: await page.getByText('已安装插件', { exact: true }).isVisible().catch(() => false),
    插件市场: await page.getByText('插件市场', { exact: true }).isVisible().catch(() => false),
    管理概览折叠: await page.getByText('管理概览', { exact: true }).isVisible().catch(() => false),
    完整性评估折叠: await page.getByText('完整性评估', { exact: true }).isVisible().catch(() => false),
  };
  console.log('PLUGIN CHECKS:', JSON.stringify(pluginChecks, null, 2));

  await modal.evaluate((el) => el.scrollTo(0, el.scrollHeight)).catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${shotDir}/06-plugins-bottom.png` });

  const allPassed = [...Object.values(mcpChecks), ...Object.values(pluginChecks)].every(Boolean);
  console.log(allPassed ? 'VERIFY: ALL PASSED' : 'VERIFY: SOME CHECKS FAILED');
  process.exitCode = allPassed ? 0 : 1;
} catch (err) {
  console.error('VERIFY ERROR:', err.message);
  await page.screenshot({ path: `${shotDir}/99-error.png` }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
