// 临时验证脚本：Mermaid 标注即编辑 + pan/zoom
// 真会话闭环：让模型画图 → 点选节点 → 一句话指令 → 图变了，flowchart / sequence 各一轮
// 用法: node scripts/claude-e2e/verify-mermaid-annotate-edit.mjs [port]
import { chromium } from '@playwright/test';

const port = process.argv[2] || '8181';
const baseUrl = `http://127.0.0.1:${port}`;
const shotDir = process.env.SHOT_DIR || '/tmp/neo-mermaid-annotate-verify';

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const checks = {};
let shotIndex = 0;
const shot = async (name) => {
  shotIndex += 1;
  await page.screenshot({ path: `${shotDir}/${String(shotIndex).padStart(2, '0')}-${name}.png` });
};

const lastSvgId = () => page.evaluate(() => {
  const svgs = [...document.querySelectorAll('svg[id^="mermaid-"]')];
  return svgs.length ? svgs[svgs.length - 1].id : null;
});

// 聊天列表是 react-virtuoso 虚拟化的，svg 计数不可靠；
// 等待条件 = 最后一张图 ≠ 基线图 + 含目标图元（可选：含指定文本）+ id 稳定 8s（流式结束）
const waitForDiagram = async ({ selector, excludeId, expectText }, timeout = 240_000) => {
  const deadline = Date.now() + timeout;
  let stableId = null;
  let stableSince = 0;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`waitForDiagram timeout (${selector} ${expectText || ''})`);
    const id = await page.evaluate(({ sel, text, skip }) => {
      const svgs = [...document.querySelectorAll('svg[id^="mermaid-"]')];
      const last = svgs[svgs.length - 1];
      if (!last || last.id === skip || !last.querySelector(sel)) return null;
      if (text && !(last.textContent || '').includes(text)) return null;
      return last.id;
    }, { sel: selector, text: expectText || null, skip: excludeId || null });
    if (id && id === stableId) {
      if (Date.now() - stableSince >= 8000) return;
    } else {
      stableId = id;
      stableSince = Date.now();
    }
    await page.waitForTimeout(1000);
  }
};

// 向上滚动聊天列表，确认存在「指定图元类型的 label 含指定文本」的旧图（旧版本可回看）
const scrollUpAndFind = async (elementSelector, text, rounds = 10) => {
  for (let i = 0; i < rounds; i += 1) {
    const found = await page.evaluate(({ sel, t }) => {
      return [...document.querySelectorAll('svg[id^="mermaid-"]')].some((svg) =>
        [...svg.querySelectorAll(sel)].some((n) => (n.textContent || '').includes(t)),
      );
    }, { sel: elementSelector, t: text });
    if (found) return true;
    await page.mouse.move(840, 400);
    await page.mouse.wheel(0, -900);
    await page.waitForTimeout(800);
  }
  return false;
};

// 等 agent turn 真正结束（流式中主输入框 placeholder 是"引导对话，本轮结束后发送…"）
const waitForIdle = async (timeout = 120_000) => {
  await page.waitForFunction(() => {
    const ta = document.querySelector('textarea');
    return ta && !(ta.placeholder || '').includes('本轮结束');
  }, undefined, { timeout });
  await page.waitForTimeout(1500);
};

const scrollToBottom = async (rounds = 14) => {
  await page.mouse.move(840, 400);
  for (let i = 0; i < rounds; i += 1) {
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(300);
  }
};

const sendChat = async (text) => {
  const input = page.locator('textarea').first();
  await input.click();
  await input.fill(text);
  await input.press('Enter');
};

const lastSvg = () => page.locator('svg[id^="mermaid-"]').last();

// 最后一张图所在 transform 容器的内联 transform
const lastViewportTransform = () => page.evaluate(() => {
  const svg = [...document.querySelectorAll('svg[id^="mermaid-"]')].pop();
  return svg?.closest('div')?.style.transform || '';
});

// 记录最后一张图里第一个目标图元的 label（点选目标）
const firstElementLabel = (selector) => page.evaluate((sel) => {
  const svgs = [...document.querySelectorAll('svg[id^="mermaid-"]')];
  const last = svgs[svgs.length - 1];
  return last?.querySelector(sel)?.textContent?.trim() || null;
}, selector);

// 点击最后一张 mermaid 图里的目标图元，返回编辑栏是否出现
const clickAndGetEditBar = async (targetSelector) => {
  const target = lastSvg().locator(targetSelector).first();
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) return false;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const editInput = page.locator('input[placeholder*="一句话"], input[placeholder*="Describe the change"]').first();
  return editInput.isVisible({ timeout: 3000 }).catch(() => false);
};

const submitEdit = async (instruction) => {
  const editInput = page.locator('input[placeholder*="一句话"], input[placeholder*="Describe the change"]').first();
  await editInput.fill(instruction);
  await editInput.press('Enter');
};

try {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  await shot('app-loaded');

  // ---------- 第一轮：flowchart ----------
  const flowBaseId = await lastSvgId();
  await sendChat('用 mermaid 画一个用户登录流程图（flowchart TD，4-5 个节点，节点用中文），只输出 mermaid 代码块，不要解释。');
  await waitForDiagram({ selector: 'g.node', excludeId: flowBaseId });
  await waitForIdle();
  await shot('flowchart-rendered');

  const svgStyle = await page.evaluate(() => {
    const svg = [...document.querySelectorAll('svg[id^="mermaid-"]')].pop();
    return svg?.style.maxWidth || '';
  });
  checks['SVG不再maxWidth压扁'] = svgStyle === 'none';

  // 点选节点 → 编辑栏（视图未动过，节点必在视口内）
  const flowOldLabel = await firstElementLabel('g.node');
  checks['flowchart点选节点出编辑栏'] = await clickAndGetEditBar('g.node');
  await shot('flowchart-node-selected');

  const flowV1Id = await lastSvgId();
  await submitEdit('把这个节点重命名为「两步验证」');
  await waitForDiagram({ selector: 'g.node', excludeId: flowV1Id, expectText: '两步验证' });
  checks['flowchart改图闭环(新图含两步验证)'] = true;
  await shot('flowchart-edited');
  // 旧版本可回看：向上滚动找到仍含旧节点名的 v1 图
  checks['flowchart旧版本仍可回看'] = flowOldLabel ? await scrollUpAndFind('g.node', flowOldLabel) : false;
  await scrollToBottom();

  // ---------- pan/zoom（在新图上验证，坐标取图视口内部）----------
  await lastSvg().scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  const viewportBox = await page.evaluate(() => {
    const svg = [...document.querySelectorAll('svg[id^="mermaid-"]')].pop();
    const viewport = svg?.closest('div')?.parentElement;
    const r = viewport?.getBoundingClientRect();
    return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
  });
  if (viewportBox) {
    const cx = viewportBox.x + viewportBox.width / 2;
    const cy = viewportBox.y + viewportBox.height / 2;

    const transformBefore = await lastViewportTransform();
    await page.evaluate(({ px, py }) => {
      const svg = [...document.querySelectorAll('svg[id^="mermaid-"]')].pop();
      const viewport = svg?.closest('div')?.parentElement;
      viewport?.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true, clientX: px, clientY: py }));
    }, { px: cx, py: cy });
    await page.waitForTimeout(300);
    const transformAfterZoom = await lastViewportTransform();
    checks['ctrl+wheel缩放生效'] = transformBefore !== transformAfterZoom && transformAfterZoom !== '';

    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 60, cy + 30, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const transformAfterDrag = await lastViewportTransform();
    checks['drag平移生效'] = transformAfterZoom !== transformAfterDrag;
    await shot('flowchart-pan-zoom');
  }

  // ---------- 第二轮：sequence ----------
  const seqBaseId = await lastSvgId();
  await sendChat('用 mermaid 画一个 sequenceDiagram：参与者「用户」和「服务器」的登录交互（3-4 条消息，中文），只输出 mermaid 代码块，不要解释。');
  await waitForDiagram({ selector: 'text.actor', excludeId: seqBaseId });
  await waitForIdle();
  await shot('sequence-rendered');

  const seqOldLabel = await firstElementLabel('text.actor');
  checks['sequence点选actor出编辑栏'] = await clickAndGetEditBar('text.actor');
  await shot('sequence-actor-selected');

  const seqV1Id = await lastSvgId();
  await submitEdit('把这个参与者改名为「认证中心」');
  await waitForDiagram({ selector: 'text.actor', excludeId: seqV1Id, expectText: '认证中心' });
  checks['sequence改图闭环(新图含认证中心)'] = true;
  await shot('sequence-edited');
  checks['sequence旧版本仍可回看'] = seqOldLabel ? await scrollUpAndFind('text.actor', seqOldLabel) : false;

  console.log('MERMAID ANNOTATE CHECKS:', JSON.stringify(checks, null, 2));
  const allPassed = Object.values(checks).every(Boolean);
  console.log(allPassed ? 'VERIFY: ALL PASSED' : 'VERIFY: SOME CHECKS FAILED');
  process.exitCode = allPassed ? 0 : 1;
} catch (err) {
  console.error('VERIFY ERROR:', err.message);
  console.log('CHECKS SO FAR:', JSON.stringify(checks, null, 2));
  await page.screenshot({ path: `${shotDir}/99-error.png` }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
