// ============================================================================
// CostDisplay 预算接线门
//
// CostDisplay 的预算感知渲染（cache-aware 成本口径 / 缓存节省 tooltip / 告警染色）
// 全靠调用方传 `budget` prop。不传不会报错、不会崩，只是静默退化：成本显示 renderer
// 自累计值（可能报少）、缓存节省那一行永不出现。
//
// 这个失效真发生过：唯一传 prop 的地方是 StatusBar/index.tsx，而那个状态栏壳零消费；
// 发行版里活着的挂载点 ChatInput 没传，于是整套预算显示在生产里暗了几个月。
//
// 断言写成**根因形状**——不是钉住某一个文件，而是要求**每一个** <CostDisplay 挂载点
// 都传 budget。将来新增第三个挂载点忘了传，一样会红。
//
// 注：纯函数层（budgetCostColorClass / normalizeBudgetStatus）另有单测，那些测的是
// 「算得对不对」；本门测的是「有没有把数据喂进去」——今天的教训是后者才是真实失效面。
// ============================================================================
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const RENDERER_DIR = path.join(process.cwd(), 'src/renderer');
const COST_DISPLAY_DEF = 'StatusBar/CostDisplay.tsx';

/** 按行丢弃注释行——被注释掉的挂载点不该算数（同 deadMainProcessPath 门的取舍）。 */
function dropCommentLines(source: string): string {
  return source
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx$/.test(entry)) out.push(full);
  }
  return out;
}

/** 找出所有 `<CostDisplay ... />` 挂载点（定义文件本身除外）。 */
function findMountSites(): Array<{ file: string; tag: string }> {
  const sites: Array<{ file: string; tag: string }> = [];
  for (const full of walk(RENDERER_DIR)) {
    const rel = path.relative(RENDERER_DIR, full);
    if (rel.endsWith(COST_DISPLAY_DEF.split('/').pop()!)) continue;
    const code = dropCommentLines(readFileSync(full, 'utf8'));
    for (const m of code.matchAll(/<CostDisplay\b[^>]*\/?>/g)) sites.push({ file: rel, tag: m[0] });
  }
  return sites;
}

describe('CostDisplay 的 budget prop 接线', () => {
  it('每个挂载点都把 budget 传下去', () => {
    const sites = findMountSites();

    // 自检：扫不到挂载点就是门失效（组件被改名/目录被挪），必须报红而非「零命中=通过」
    expect(
      sites.length,
      '全 renderer 扫不到任何 <CostDisplay 挂载点——本门的匹配口径已失效（组件改名？目录移动？），请修门而不是放行',
    ).toBeGreaterThan(0);

    const missing = sites.filter((s) => !/\bbudget=/.test(s.tag));
    expect(
      missing.map((s) => `${s.file}: ${s.tag}`),
      '以下 CostDisplay 挂载点没传 budget —— 该处的成本会显示 renderer 自累计值（可能报少），'
      + '缓存节省与预算染色静默失效。这种退化不会崩、不会报错，只能靠本门发现。',
    ).toEqual([]);
  });
});
