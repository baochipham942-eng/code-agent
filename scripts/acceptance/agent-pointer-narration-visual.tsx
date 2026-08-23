import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentPointerEvent } from '../../src/shared/contract';
import {
  AgentPointerGlyph,
  AgentPointerOverlay,
} from '../../src/renderer/components/workbench/AgentPointerOverlay';
import { useAppStore } from '../../src/renderer/stores/appStore';
import {
  closeSystemChromeSession,
  launchSystemChromeSession,
} from './browser-computer-system-chrome';

const OUT_DIR = '/Users/linchen/Downloads/ai/code-agent-private-archive/docs/evidence/N-L9-NARRATION-assets';

const scenarios: Array<{ kind: string; event: AgentPointerEvent }> = [
  {
    kind: '导航 / Navigate',
    event: {
      id: 'visual-navigate', surface: 'browser', tone: 'browser', phase: 'navigate',
      coordSpace: 'browserViewport', point: { x: 8, y: 28, unit: 'percent' },
      targetLabel: 'flights.ctrip.com/search', targetSource: 'fallback', success: true,
    },
  },
  {
    kind: '点击 / Click',
    event: {
      id: 'visual-click', surface: 'browser', tone: 'browser', phase: 'click',
      coordSpace: 'browserViewport', point: { x: 8, y: 28, unit: 'percent' },
      targetLabel: '8/20 上海→北京的航班', targetSource: 'targetRef', success: true,
    },
  },
  {
    kind: '输入 / Input',
    event: {
      id: 'visual-input', surface: 'browser', tone: 'browser', phase: 'type',
      coordSpace: 'browserViewport', point: { x: 8, y: 28, unit: 'percent' },
      targetLabel: '出发城市', targetSource: 'targetRef', success: true,
    },
  },
  {
    kind: '等待 / Wait',
    event: {
      id: 'visual-wait', surface: 'browser', tone: 'browser', phase: 'wait',
      coordSpace: 'browserViewport', point: { x: 8, y: 28, unit: 'percent' },
      targetLabel: '航班搜索结果', targetSource: 'targetRef', success: true,
    },
  },
];

function legacyPhase(event: AgentPointerEvent): string {
  if (event.phase === 'click') return 'click';
  if (event.phase === 'type') return 'input';
  return 'target';
}

function LegacyPointerOverlay({ event }: { event: AgentPointerEvent }) {
  return (
    <div className="pointer-layer">
      <div className="pointer-position">
        <AgentPointerGlyph tone={event.tone} phase={event.phase} size={34} />
        <span className="pointer-label">
          {legacyPhase(event)} <span className="pointer-target">· {event.targetLabel}</span>
        </span>
      </div>
    </div>
  );
}

function BrowserBackdrop({ kind }: { kind: string }) {
  return (
    <div className="browser-backdrop">
      <div className="browser-chrome"><span /><span /><span /><div>flights.ctrip.com</div></div>
      <div className="scenario-kind">{kind}</div>
      <div className="travel-copy">上海 <b>→</b> 北京</div>
      <div className="travel-meta">8月20日 · 单程 · 经济舱</div>
      <div className="flight-row"><strong>09:30</strong><span>虹桥 T2</span><em>¥680</em></div>
      <div className="flight-row secondary"><strong>11:15</strong><span>浦东 T1</span><em>¥720</em></div>
    </div>
  );
}

function VisualGrid({ mode }: { mode: 'before' | 'after' }) {
  return (
    <main>
      <header>
        <span>Neo 浏览器实时现场</span>
        <small>{mode === 'before' ? 'BEFORE · 原始工具标签' : 'AFTER · 人话旁白'}</small>
      </header>
      <div className="grid">
        {scenarios.map(({ kind, event }) => (
          <section className="card" key={event.id}>
            <BrowserBackdrop kind={kind} />
            {mode === 'before'
              ? <LegacyPointerOverlay event={event} />
              : <AgentPointerOverlay event={event} />}
          </section>
        ))}
      </div>
    </main>
  );
}

const styles = `
  *{box-sizing:border-box}body{margin:0;background:#09090b;color:#f4f4f5;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  main{width:1120px;min-height:650px;padding:26px 30px;background:radial-gradient(circle at 90% 0,#172554 0,transparent 34%),#09090b}
  header{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px;font-size:20px;font-weight:650}header small{color:#a1a1aa;font-size:12px;letter-spacing:.12em}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.card{position:relative;height:260px;overflow:hidden;border:1px solid #3f3f46;border-radius:12px;background:#18181b;box-shadow:0 14px 30px #0008}
  .browser-backdrop{position:absolute;inset:0;background:linear-gradient(160deg,#f8fafc,#dbeafe);color:#172033;padding:58px 22px 18px}.browser-chrome{position:absolute;inset:0 0 auto;height:38px;background:#27272a;display:flex;align-items:center;gap:6px;padding:0 12px}.browser-chrome>span{width:9px;height:9px;border-radius:50%;background:#71717a}.browser-chrome>div{margin-left:10px;width:310px;border-radius:6px;background:#3f3f46;color:#d4d4d8;font-size:10px;padding:5px 10px}.scenario-kind{position:absolute;right:18px;top:54px;color:#64748b;font-size:11px}.travel-copy{font-size:23px;font-weight:700}.travel-copy b{padding:0 14px;color:#2563eb}.travel-meta{margin-top:5px;color:#64748b;font-size:12px}.flight-row{margin-top:18px;display:grid;grid-template-columns:76px 1fr 70px;align-items:center;background:#fff;border:1px solid #cbd5e1;border-radius:8px;padding:10px 13px;font-size:12px}.flight-row strong{font-size:18px}.flight-row em{color:#ea580c;font-size:15px;font-style:normal;font-weight:700}.flight-row.secondary{margin-top:7px;opacity:.7}
  .pointer-events-none,.pointer-layer{pointer-events:none;position:absolute;inset:0;z-index:20;overflow:hidden}.pointer-events-none>.absolute.flex,.pointer-position{position:absolute;left:8%;top:28%;display:flex;align-items:flex-start;gap:8px;transform:translate(-8px,-8px)}.pointer-events-none svg,.pointer-position svg{flex:none}.pointer-events-none span[class*="max-w"],.pointer-label{margin-top:4px;max-width:340px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border:1px solid #ffffff20;background:#09090be8;color:#f4f4f5;border-radius:7px;padding:7px 10px;font-size:14px;font-weight:600;box-shadow:0 7px 18px #0009}.pointer-target{color:#a1a1aa}
  .pointer-events-none>span{display:none}
`;

function buildHtml(mode: 'before' | 'after', language: 'zh' | 'en'): string {
  useAppStore.setState({ language });
  useAppStore.getInitialState().language = language;
  const body = renderToStaticMarkup(<VisualGrid mode={mode} />);
  return `<!doctype html><html><head><meta charset="utf-8"><style>${styles}</style></head><body>${body}</body></html>`;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const session = await launchSystemChromeSession({ profilePrefix: 'l9-narration-visual-' });
  const outputs = [
    { name: '01-before-four-actions.png', mode: 'before' as const, language: 'zh' as const },
    { name: '02-after-zh-four-actions.png', mode: 'after' as const, language: 'zh' as const },
    { name: '03-after-en-four-actions.png', mode: 'after' as const, language: 'en' as const },
  ];

  try {
    const context = session.browser.contexts()[0] || await session.browser.newContext();
    const page = context.pages()[0] || await context.newPage();
    await page.setViewportSize({ width: 1120, height: 650 });
    for (const output of outputs) {
      await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(buildHtml(output.mode, output.language))}`);
      await page.screenshot({ path: path.join(OUT_DIR, output.name), fullPage: true });
    }
    console.log(JSON.stringify({
      ok: true,
      provider: session.provider,
      executable: session.executable,
      outputs: outputs.map((output) => path.join(OUT_DIR, output.name)),
    }, null, 2));
  } finally {
    await session.browser.close().catch(() => undefined);
    await closeSystemChromeSession(session).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
