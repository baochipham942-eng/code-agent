// ============================================================================
// SESSION 域 action 三面对账门（2026-07-25 费曼审计 P2-2）
//
// 「新 IPC action 必须 session.ipc + webServer + shellCapabilities 三处一起接」
// 此前是人肉规则（错题本条目），漏一处 = 桌面能用 web 不能用（或反之）/
// 能力清单骗人。本门把三面枚举 diff 钉死：
//   ① src/host/ipc/session.ipc.ts 的 action switch（case 标签）
//   ② src/web/sessionDomainHandler.ts 的 session action switch（case 标签）
//   ③ shellCapabilities 能力清单（getShellCapabilities 的 session 域）
//
// 自举纪律：任一面提取到 0 个 action → 报红（锚点失效不假绿）；
// 差集报错指名道姓一次列全（deny-list-by-name 教训）。
// ============================================================================
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getShellCapabilities } from '../../src/host/shellCapabilities';

const repoRoot = path.resolve(__dirname, '../..');

/**
 * 从 anchor 文本处括号配对截取块，收集其中的 action 处理标签：
 * `case 'x':` 与 `action === 'x'` 两种形态都算（webServer 的三个 model
 * override action 走 if 形态）。避免整文件 grep 撞到别处 switch 的同名 case。
 */
function extractActions(file: string, anchorText: string): string[] {
  const source = fs.readFileSync(path.join(repoRoot, file), 'utf-8');
  const anchorIdx = source.indexOf(anchorText);
  expect(anchorIdx, `${file} 里找不到锚点「${anchorText}」——结构变了，更新本门锚点`).toBeGreaterThan(-1);

  // case 锚点要回溯到所属 switch，取整个 switch 块；其余锚点（handler 注册处）从锚点向后取块
  let blockStart = anchorIdx;
  if (anchorText.startsWith("case '")) {
    blockStart = source.lastIndexOf('switch (', anchorIdx);
    expect(blockStart, `${file} 锚点上方找不到 switch(——结构变了，更新本门`).toBeGreaterThan(-1);
  }

  const openBrace = source.indexOf('{', blockStart);
  let depth = 0;
  let end = -1;
  for (let i = openBrace; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  expect(end, `${file} 块括号配对失败`).toBeGreaterThan(-1);

  const block = source.slice(openBrace, end);
  const actions = [
    ...[...block.matchAll(/^\s*case '([^']+)':/gm)].map((m) => m[1]),
    ...[...block.matchAll(/action === '([^']+)'/g)].map((m) => m[1]),
  ];
  return [...new Set(actions)];
}

/**
 * 已知存量缺口（本门 2026-07-26 建门时实测挖出，复查 2026-08-25）：
 * 以下 6 个 action 在 webServer 路径没接——而发行版全走 webServer，等于这些能力
 * 在生产是死的（Electron main 路径已废，见 initBackgroundServices DEAD PATH 注）。
 * 基线只减不增：修一个必须从这里删掉一行，否则报红（自收紧棘轮）。
 */
const KNOWN_WEBSERVER_GAPS = new Set([
  'exportDiagnostics',
  'exportMarkdown',
  'getMemoryContext',
  'import',
  'search',
]);

describe('SESSION 域 action 三面对账', () => {
  const ipcActions = new Set(extractActions('src/host/ipc/session.ipc.ts', "case 'rewindToPrompt'"));
  const webActions = new Set(extractActions('src/web/sessionDomainHandler.ts', "deps.handlers.set('domain:session'"));
  const manifestActions = new Set(
    getShellCapabilities()
      .filter((c) => c.domain === 'domain:session')
      .map((c) => c.action),
  );

  it('每一面都提取到了 action（锚点有效性）', () => {
    expect(ipcActions.size).toBeGreaterThan(0);
    expect(webActions.size).toBeGreaterThan(0);
    expect(manifestActions.size).toBeGreaterThan(0);
  });

  it('三面 action 集合一致（新 action 三处一起接；已知缺口走基线）', () => {
    const all = new Set([...ipcActions, ...webActions, ...manifestActions]);
    const problems: string[] = [];
    for (const action of [...all].sort()) {
      const missing = [
        !ipcActions.has(action) ? 'session.ipc' : '',
        !webActions.has(action) && !KNOWN_WEBSERVER_GAPS.has(action) ? 'webServer' : '',
        !manifestActions.has(action) ? 'shellCapabilities' : '',
      ].filter(Boolean);
      if (missing.length) problems.push(`  ${action} → 缺 ${missing.join(' / ')}`);
    }
    expect(
      problems,
      `以下 SESSION action 没有三面接齐（session.ipc / webServer / shellCapabilities）：\n${problems.join('\n')}`,
    ).toEqual([]);
  });

  it('已知缺口基线只减不增（修好一个必须同步删基线，别让清单腐烂）', () => {
    for (const action of KNOWN_WEBSERVER_GAPS) {
      expect(
        webActions.has(action),
        `${action} 已在 webServer 接上了——从 KNOWN_WEBSERVER_GAPS 基线删掉它`,
      ).toBe(false);
      expect(ipcActions.has(action), `基线里的 ${action} 在 session.ipc 都不存在了——基线过期，更新它`).toBe(true);
    }
  });
});
