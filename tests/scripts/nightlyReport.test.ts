import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

// report.ts 在模块加载时就展开 ~/Downloads/… 归档路径，导入前先把 HOME 指到临时目录，产出全部落在隔离区。
const realHome = os.homedir();
const home = mkdtempSync(path.join(os.tmpdir(), 'nightly-report-home-'));
process.env.HOME = home;
// playwright 的浏览器注册表随 HOME 解析默认缓存；HOME 已替换，指回真实缓存避免重新下载浏览器。
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(realHome, process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright');
const archive = path.join(home, 'Downloads/ai/code-agent-private-archive');
mkdirSync(path.join(archive, 'tools'), { recursive: true });
// 真实 md2html.py 会把 lead 包进 <main>；桩保持同形，renderReport 内部的 h1/首屏自检才跑得过。
writeFileSync(path.join(archive, 'tools/md2html.py'), 'import sys\nhtml = sys.argv[2]\nlead = sys.argv[sys.argv.index("--lead") + 1]\nopen(html, "w").write("<main>" + open(lead).read() + "</main>")\n');

const { parseCases } = await import('../../scripts/nightly/contracts');
const { renderReport } = await import('../../scripts/nightly/report');

function inventory(count: number) {
  return parseCases(Array.from({ length: count }, (_, i) => `### TC-M${i + 1}-01 · 样例 ${i + 1}\n\n| 夜跑标记 | 是 |\n| 模块 | 上下文·数据 |\n| 验收面 | api+web |\n| 步骤 | 浏览器打开详情；API 读取 health:get |\n| 证据落点 | 拟执行：\`~/fixture/runs/TC-M${i + 1}-01/<run-id>/result.json\` |\n| ①结果断言 | result |\n| ②过程断言 | process |\n| ③渲染断言 | render |\n`).join('\n'));
}

describe('nightly report case-table surface', () => {
  it('renders the 10-column header with 标题/模块/验收面 verbatim per case', { timeout: 60_000 }, async () => {
    const cases = inventory(55);
    const rows = cases.map(c => ({ id: c.id, runId: 'fixture-run', status: '未执行' as const, reasons: ['fixture 未执行'], checks: [1, 2, 3].map(() => ({ status: '未执行' as const, detail: 'fixture' })), files: {}, frames: [] }));
    const report = await renderReport(cases, rows, null, '2026-09-07', 'fixture-run', ['门：fixture']);
    expect(report.summary.total).toBe(55);
    const html = readFileSync(report.html, 'utf8');
    const thead = html.match(/<table id="case-table"><thead><tr>(.*?)<\/tr><\/thead>/)![1];
    expect([...thead.matchAll(/<th>([^<]*)<\/th>/g)].map(m => m[1])).toEqual(['用例', '标题', '模块', '验收面', '结论', '①结果', '②过程', '③渲染', '说明', '缺陷']);
    expect(thead.match(/<th>/g)).toHaveLength(10);
    for (const id of ['TC-M1-01', 'TC-M28-01', 'TC-M55-01']) { // 抽 3 条断言标题/模块/验收面与解析值一致
      const spec = cases.find(c => c.id === id)!;
      const row = html.match(new RegExp(`<tr data-case="${id}"[^>]*>([\\s\\S]*?)</tr>`))![1];
      expect(row).toContain(`<td>${spec.title}</td>`);
      expect(row).toContain(`<code>${spec.modules.join('·')}</code>`);
      expect(row).toContain(`<code>${spec.surfaces.join('+')}</code>`);
    }
    expect(html).toContain(`真跑 0 条 / 未执行 55 条 / 共 ${cases.length} 条`);
  });
});
