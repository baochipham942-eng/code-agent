// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { CompanionConversation } from '../../../packages/mobile/src/features/sessions/CompanionConversation';
import { messages, runOutcomeCopy } from '../../../packages/mobile/src/i18n';
import type { CompanionEvent } from '../../../src/shared/contract/companion';

const text = messages('zh');
let seq = 0;
const ev = (kind: string, payload: Record<string, unknown>) => ({ eventId: `e${++seq}`, sessionId: 's1', kind, payload }) as unknown as CompanionEvent;

function view(events: CompanionEvent[], running: { stop?(): void; stopDisabled?: boolean } | null = null) {
  return <CompanionConversation events={events} artifacts={[]} sessionId="s1" text={text} loadMore={() => {}} disabled={false}
    respond={async () => {}} respondQuestion={async () => {}} respondPlan={async () => {}} openArtifact={() => {}} running={running} />;
}

/** 滚动区里按文档顺序排的「消息 / 终态行 / 执行条」，其余元素不看。 */
function stream(): string[] {
  const scroller = document.querySelector('.lan-messages')!;
  return Array.from(scroller.children).flatMap(node => {
    if (node.classList.contains('run-outcome')) return [`outcome:${node.textContent}`];
    if (node.classList.contains('run-strip')) return ['run-strip'];
    if (node.classList.contains('from-user')) return [`user:${node.textContent}`];
    if (node.classList.contains('lan-message')) return [`neo:${node.querySelector('.assistant-text')?.textContent}`];
    return [];
  });
}

import { readFileSync } from 'node:fs';

// 成功不再挂文案行之后，真实宿主验收脚本就不能再等「任务已完成」——它等不到，只会超时。
// 更要命的是 verify-host 里那道「没问审批就跑完了」的护栏原本也靠这句话触发：文案没了，
// 护栏永远不触发且不报错（装好没接电）。所以把新判据钉住：脚本认 run-strip，组件必须真发这个 testid。
describe('真实宿主验收脚本与「成功不挂行」保持同一套判据（ai-review PR#1898 Important）', () => {
  const script = readFileSync('packages/mobile/scripts/verify-host.mjs', 'utf8');

  it('验收脚本改用执行条消失当「这一轮结束」，不再等被删掉的成功文案', () => {
    // 钉承重点，不钉措辞：等的对象是执行条这个定位符，且被删掉的成功文案不许再出现。
    expect(script).toContain("const strip = page.getByTestId('run-strip');");
    expect(script).toContain("await strip.waitFor({state:'detached'});");
    expect(script).not.toContain('任务已完成');
    // 停止仍有文案行，那条判据不动
    expect(script).toContain("page.getByText('任务已停止',{exact:true})");
  });

  it('reload 之后不拿「元素不在」当完成——先等重连，再等「执行条不在且已有助手回复」（ai-review PR#1898 第二轮）', () => {
    // 直接等 detached 在 reload 后是恒真的：React 还没挂载时元素本来就不在，Playwright 立刻判满足。
    // 钉承重点不钉措辞：①reload 后必须走收敛函数，不许再回到 detached；②该函数第一步先等重连。
    expect(script).toMatch(/await page\.reload\(\);await runSettledAfterReload\(/);
    expect(script).not.toMatch(/page\.reload\(\);\s*await strip\.waitFor/);
    expect(script).toMatch(/runSettledAfterReload = async [^\n]*=> \{\s*\n\s*await page\.getByText\('已连接电脑'/);
  });

  it('失败判据锚 data-outcome，不锚「任务失败」这句措辞（失败行带原因，exact 打不中）', () => {
    expect(script).toContain("page.locator('.run-outcome[data-outcome=\"failed\"]')");
    expect(script).not.toContain("getByText('任务失败'");
    const component = readFileSync('packages/mobile/src/features/sessions/CompanionConversation.tsx', 'utf8');
    expect(component).toContain('data-outcome={outcome.kind}');
  });

  it('reload 后的回复判据绑定这一轮：比点审批前的基线多才算收敛', () => {
    expect(script).toContain('const repliesBeforeApproval = await assistantReplies();');
    expect(script).toContain('await runSettledAfterReload(repliesBeforeApproval);');
    expect(script).toContain('if(!live && replies > repliesBefore) return;');
  });

  it('等执行条消失的前提是它此刻真的挂着——否则又是一个恒真判据', () => {
    expect(script).toContain("assert(await strip.count() > 0, 'run strip must be mounted before waiting for it to vanish');");
  });

  it('「没问审批就跑完」的护栏仍然会炸，而不是静默失效', () => {
    expect(script).toMatch(/runEnded\(\)\.then\(\(\)=>\{throw new Error\('TASK_FINISHED_WITHOUT_REQUIRED_APPROVAL'\);\}\)/);
  });

  it('verify-lan 等那句延迟提示时必须显式给足超时，且不许改锚「草稿被清空」（那条恒不成立）', () => {
    const lan = readFileSync('packages/mobile/scripts/verify-lan.mjs', 'utf8');
    // 承重点一：那句提示现在要憋过 pendingNoticeDelayMs，靠 Playwright 默认 5s 只剩两秒余量。
    expect(lan).toMatch(/正在核对电脑是否已接收[^\n]*waitFor\(\{ timeout: 15_000 \}\)/);
    // 承重点二：丢回执那条路径故意不回 ack ⇒ 草稿永远不会被清（acknowledgeDraft 只在 ack 后跑）。
    // 拿它当判据是**恒不成立**，整条浏览器验收会挂死（grok ai-review PR#1903 Important）。
    expect(lan).not.toContain("[data-testid=\"draft\"]')?.value === ''");
  });

  it('组件确实发 run-strip 这个 testid——判据锚的元素必须真存在，否则 detached 恒真', () => {
    const component = readFileSync('packages/mobile/src/features/sessions/CompanionConversation.tsx', 'utf8');
    expect(component).toContain('data-testid="run-strip"');
  });
});

describe('执行状态挂在对应那次执行下面（N-MOBILE-EXEC-STATUS ①②）', () => {
  afterEach(cleanup);

  it('两次任务一败一成：失败挂在它那次回复下面，成功不挂行（爸 09-16 build 41）', () => {
    render(view([
      ev('message', { id: 'u1', role: 'user', content: '做表', runId: 'r1' }),
      ev('message', { id: 'a1', role: 'assistant', content: '开始', runId: 'r1' }),
      ev('error', { code: 'MODEL_AUTH', runId: 'r1' }),
      ev('agent_complete', { runId: 'r1' }),
      ev('message', { id: 'u2', role: 'user', content: '再试', runId: 'r2' }),
      ev('message', { id: 'a2', role: 'assistant', content: '好了', runId: 'r2' }),
      ev('agent_complete', { runId: 'r2' }),
    ]));
    expect(stream()).toEqual([
      'user:做表', 'neo:开始', `outcome:${runOutcomeCopy(text, 'failed', 'MODEL_AUTH')}`,
      'user:再试', 'neo:好了',
    ]);
  });

  // N-MOBILE-RUNFAIL-REASON（build 45 真机 403 被说成「电脑执行时出了问题」）：失败态要带出路。
  it('模型密钥用不了：最近那次失败下面给「换一个可用模型」，点了直达模型选择；兜底失败不给这个动作', () => {
    const openModel = vi.fn();
    const withModel = (events: CompanionEvent[]) => <CompanionConversation events={events} artifacts={[]} sessionId="s1" text={text} loadMore={() => {}} disabled={false}
      respond={async () => {}} respondQuestion={async () => {}} respondPlan={async () => {}} openArtifact={() => {}} openModel={openModel} />;
    const failed = [
      ev('message', { id: 'u1', role: 'user', content: '你好', runId: 'r1' }),
      ev('error', { code: 'MODEL_AUTH', runId: 'r1' }),
      ev('agent_complete', { runId: 'r1' }),
    ];
    const { rerender } = render(withModel(failed));
    expect(runOutcomeCopy(text, 'failed', 'MODEL_AUTH')).not.toContain(text.runFailed);
    // 卡片显示时消息流不出红字行（N-MOBILE-RUNFAIL-DUP）
    expect(stream()).not.toContain(`outcome:${runOutcomeCopy(text, 'failed', 'MODEL_AUTH')}`);
    const card = document.querySelector('[data-testid="model-auth-failed"]')!;
    expect(card.textContent).toContain(text.modelAuthTitle);
    expect(card.textContent).toContain(text.modelAuthDetail);
    expect(card.querySelector('button')!.textContent).toBe(text.switchModel);
    fireEvent.click(card.querySelector('button')!);
    expect(openModel).toHaveBeenCalledTimes(1);
    // 之后又跑成功了一轮：卡片收起，留一行「任务失败：…」当记录
    rerender(withModel([...failed,
      ev('message', { id: 'u2', role: 'user', content: '再试', runId: 'r2' }),
      ev('message', { id: 'a2', role: 'assistant', content: '好了', runId: 'r2' }),
      ev('agent_complete', { runId: 'r2' }),
    ]));
    expect(stream()).toContain(`outcome:${runOutcomeCopy(text, 'failed', 'MODEL_AUTH')}`);
    expect(document.querySelector('[data-testid="model-auth-failed"]')).toBeNull();
    // 兜底失败说不出原因，也就给不出「换模型」这条路
    rerender(withModel([ev('message', { id: 'u3', role: 'user', content: 'x', runId: 'r3' }), ev('error', { code: 'RUN_FAILED', runId: 'r3' })]));
    expect(stream()).toContain(`outcome:${runOutcomeCopy(text, 'failed', 'RUN_FAILED')}`);
    expect(document.querySelector('[data-testid="model-auth-failed"]')).toBeNull();
  });

  // 爸 2026-09-16 真机：已经换成能用的模型，「换一个可用模型」还挂着
  it('失败的模型已经被换走就收起换模型卡；换回同一个坏模型会再出现；旧宿主不带模型照旧显示', () => {
    const conv = (events: CompanionEvent[], sessionModel: { provider: string; model: string } | null) => <CompanionConversation events={events} artifacts={[]} sessionId="s1" text={text} loadMore={() => {}} disabled={false}
      respond={async () => {}} respondQuestion={async () => {}} respondPlan={async () => {}} openArtifact={() => {}} openModel={() => {}} sessionModel={sessionModel} />;
    const failed = [
      ev('message', { id: 'u1', role: 'user', content: '你好', runId: 'r1' }),
      ev('error', { code: 'MODEL_AUTH', provider: 'custom-team-relay', model: 'LongCat-2.0', runId: 'r1' }),
    ];
    const card = () => document.querySelector('[data-testid="model-auth-failed"]');
    const { rerender } = render(conv(failed, { provider: 'custom-team-relay', model: 'LongCat-2.0' }));
    // 前提自证：还是那个坏模型时卡片在，红字行不在
    expect(card()).not.toBeNull();
    expect(stream()).not.toContain(`outcome:${runOutcomeCopy(text, 'failed', 'MODEL_AUTH')}`);
    rerender(conv(failed, { provider: 'longcat', model: 'LongCat-2.0' }));
    expect(card()).toBeNull();
    // 失败原因那一行留着——那次执行确实失败了
    expect(stream()).toContain(`outcome:${runOutcomeCopy(text, 'failed', 'MODEL_AUTH')}`);
    rerender(conv(failed, { provider: 'custom-team-relay', model: 'LongCat-2.0' }));
    expect(card()).not.toBeNull();
    rerender(conv([failed[0], ev('error', { code: 'MODEL_AUTH', runId: 'r1' })], { provider: 'longcat', model: 'LongCat-2.0' }));
    expect(card()).not.toBeNull();
    // 电脑同一次失败发两条 error，不带模型的那条先到：照样认得失败的是哪个模型（远端验收 seq 36/37）
    rerender(conv([failed[0], ev('error', { code: 'MODEL_AUTH', runId: 'r1' }), failed[1]], { provider: 'longcat', model: 'LongCat-2.0' }));
    expect(card()).toBeNull();
  });

  it('只成功的一轮：回复下面什么都不挂——回复本身就是成功的证据', () => {
    render(view([
      ev('message', { id: 'u1', role: 'user', content: '你好', runId: 'r1' }),
      ev('message', { id: 'a1', role: 'assistant', content: '你好，有什么可以帮你的？', runId: 'r1' }),
      ev('agent_complete', { runId: 'r1' }),
    ]));
    expect(stream()).toEqual(['user:你好', 'neo:你好，有什么可以帮你的？']);
    expect(document.querySelector('.run-outcome')).toBeNull();
  });

  it('模型停用：卡片文案一字不差，显示时不出红字；换走后留记录行', () => {
    const openModel = vi.fn();
    const conv = (events: CompanionEvent[], sessionModel: { provider: string; model: string } | null) => <CompanionConversation events={events} artifacts={[]} sessionId="s1" text={text} loadMore={() => {}} disabled={false}
      respond={async () => {}} respondQuestion={async () => {}} respondPlan={async () => {}} openArtifact={() => {}} openModel={openModel} sessionModel={sessionModel}
      models={[{ provider: 'longcat', model: 'LongCat-2.0-Preview', label: 'LongCat 2.0 Preview' }]} />;
    const failed = [
      ev('message', { id: 'u1', role: 'user', content: '你好', runId: 'r1' }),
      ev('error', { code: 'MODEL_UNAVAILABLE', provider: 'longcat', model: 'LongCat-2.0-Preview', runId: 'r1' }),
    ];
    const { rerender } = render(conv(failed, { provider: 'longcat', model: 'LongCat-2.0-Preview' }));
    const card = document.querySelector('[data-testid="model-unavailable"]')!;
    expect(card.querySelector('h3')!.textContent).toBe('这个模型用不了了');
    expect(card.querySelector('p')!.textContent).toBe('供应商已经停用 LongCat 2.0 Preview。换一个模型就能继续。');
    expect(card.querySelector('button')!.textContent).toBe('换一个可用模型');
    expect(stream()).not.toContain(`outcome:${runOutcomeCopy(text, 'failed', 'MODEL_UNAVAILABLE')}`);
    fireEvent.click(card.querySelector('button')!);
    expect(openModel).toHaveBeenCalledTimes(1);
    rerender(conv(failed, { provider: 'longcat', model: 'LongCat-2.0' }));
    expect(document.querySelector('[data-testid="model-unavailable"]')).toBeNull();
    expect(stream()).toContain(`outcome:${text.failed}：${text.modelGoneLabel}`);
  });

  it('RUN_FAILED / PROJECT_SOURCE_* / stopped 仍挂执行结果行，不走模型卡', () => {
    for (const code of ['RUN_FAILED', 'PROJECT_SOURCE_MISSING', 'PROJECT_SOURCE_CHANGED', 'PROJECT_SOURCE_UNTRUSTED'] as const) {
      cleanup();
      render(view([
        ev('message', { id: 'a1', role: 'assistant', content: '处理中', runId: 'r1' }),
        ev('error', { code, runId: 'r1' }),
      ], null));
      expect(stream()).toEqual(['neo:处理中', `outcome:${runOutcomeCopy(text, 'failed', code)}`]);
      expect(document.querySelector('[data-testid="model-auth-failed"]')).toBeNull();
      expect(document.querySelector('[data-testid="model-unavailable"]')).toBeNull();
    }
    cleanup();
    render(view([
      ev('message', { id: 'a1', role: 'assistant', content: '处理中', runId: 'r1' }),
      ev('agent_cancelled', { runId: 'r1' }),
    ]));
    expect(stream()).toEqual(['neo:处理中', `outcome:${text.stopped}`]);
  });

  it('失败行带原因；同一次执行先报错后收尾，失败说了算', () => {
    render(view([
      ev('message', { id: 'a1', role: 'assistant', content: '处理中', runId: 'r1' }),
      ev('error', { code: 'RUN_FAILED', runId: 'r1' }),
      ev('agent_complete', { runId: 'r1' }),
    ]));
    expect(stream()).toEqual(['neo:处理中', `outcome:${text.failed}：${text.runFailed}`]);
  });

  it('流式回复中途结束、正式消息后到：终态跟着换成正式那一行，不丢也不落到底部', () => {
    render(view([
      ev('message', { id: 'u1', role: 'user', content: '写', runId: 'r1' }),
      ev('message_snapshot', { content: '草', turnId: 't1', runId: 'r1' }),
      ev('agent_cancelled', { runId: 'r1' }),
      ev('message', { id: 'a1', role: 'assistant', content: '草稿', runId: 'r1' }),
    ]));
    expect(stream()).toEqual(['user:写', 'neo:草稿', `outcome:${text.stopped}`]);
  });

  it('处理中：执行条在最后一条下面，只说「哪一次在跑」不带停止；任务结束（running=null）即消失', () => {
    const stop = vi.fn();
    const events = [ev('message', { id: 'u1', role: 'user', content: '跑', runId: 'r1' })];
    const rendered = render(view(events, {}));
    expect(stream()).toEqual(['user:跑', 'run-strip']);
    const strip = document.querySelector('[data-testid="run-strip"]')!;
    expect(strip.textContent).toContain(text.running);
    // 停止收进输入区那个键（N-MOBILE-SEND-IS-STOP）：同一个动作不该有两个落点。
    // 钉「条里没有任何按钮」而不是「没有那个文案」——换个词照样是第二个落点。
    expect(strip.querySelectorAll('button')).toHaveLength(0);
    expect(stop).not.toHaveBeenCalled();
    rendered.rerender(view(events, null));
    expect(document.querySelector('[data-testid="run-strip"]')).toBeNull();
  });

  it('录音面板顶掉输入区时（调用方给了 stop）执行条把停止接回来——否则运行中一开录音就没法停', () => {
    const stop = vi.fn();
    const events = [ev('message', { id: 'u1', role: 'user', content: '跑', runId: 'r1' })];
    render(view(events, { stop, stopDisabled: false }));
    const strip = document.querySelector('[data-testid="run-strip"]')!;
    expect(strip.querySelectorAll('button')).toHaveLength(1);
    fireEvent.click(strip.querySelector('button')!);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
