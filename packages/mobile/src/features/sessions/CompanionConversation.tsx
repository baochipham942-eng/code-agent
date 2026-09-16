import type { CompanionArtifact, CompanionHistory } from '../../../../../src/shared/contract/companionLibrary';
import { Fragment, useLayoutEffect, useRef, useState } from 'react';
import { NeoBrandMark } from '../brand/NeoBrandMark';
import { ApprovalCard } from './ApprovalCard';
import { QuestionCard } from './QuestionCard';
import { PlanCard } from './PlanCard';
import type { CompanionEvent } from '../../../../../src/shared/contract/companion';
import { runOutcomeCopy, type messages } from '../../i18n';

type RunOutcome = { anchor: string | undefined; kind: 'stopped' | 'failed'; code?: string };

/**
 * 「跟到底」只滚到刚好露出最后一个元素的下沿为止（build 40 真机：进会话第一条上半被顶栏裁掉）。
 * 原来一律把 scrollTop 拉到 scrollHeight，而 scrollHeight 里还算着最后一条的下外边距和输入区上方的留白
 * （真引擎实测 42px）：会话约莫一屏时，这 42px 的多滚正好把第一条的上半截推出可视区。
 * 现在最后一条的下沿贴着输入区那一层（含键盘）的上沿，整段放得下时就停在 0。
 * 输入区还没量到高度时量不准，照旧拉到底。
 */
function followTop(el: HTMLElement, composerHeight: number): number {
  const last = el.lastElementChild;
  if (!last || composerHeight <= 0) return el.scrollHeight;
  const keyboard = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--keyboard-h')) || 0;
  const bottom = last.getBoundingClientRect().bottom - el.getBoundingClientRect().top + el.scrollTop;
  return Math.min(el.scrollHeight, Math.max(0, Math.ceil(bottom - (el.clientHeight - composerHeight - keyboard))));
}

export function CompanionConversation({ history, loadMore, hidePendingApprovals = false, events, artifacts, sessionId, text, disabled, respond, respondQuestion, respondPlan, openArtifact, composerHeight = 0, offline = false, running = null }: { history?: CompanionHistory; loadMore(): void; hidePendingApprovals?: boolean; events: CompanionEvent[]; artifacts: CompanionArtifact[]; sessionId: string; text: ReturnType<typeof messages>; disabled: boolean; respond: (requestId: string, decision: 'approved' | 'rejected') => Promise<void>; respondQuestion: (requestId: string, answers: Record<string, string | string[]>, declined?: boolean, reason?: string) => Promise<void>; respondPlan: (requestId: string, decision: 'approved' | 'rejected', feedback?: string) => Promise<void>; openArtifact(id: string): void;
  /** 输入区那一层的实测高度：它一变，滚动区的底部内边距跟着变，贴底的人得重新贴一次。 */
  composerHeight?: number;
  /** Offline reread: hide load-more (it cannot fetch) without changing the composer. */
  offline?: boolean;
  /** 这条会话正在电脑上跑：最后一条下面给执行条。null = 没在跑，执行条不渲染（任务一结束就消失）。 */
  running?: { stop(): void; stopDisabled: boolean } | null }) {
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const isRunning = Boolean(running);
  useLayoutEffect(() => { following.current = true; setShowLatest(false); }, [sessionId]);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!following.current || !el) return;
    el.scrollTop = followTop(el, composerHeight);
  }, [events, sessionId, history, composerHeight, isRunning]);
  const approvals = new Map<string, Record<string, unknown>>();
  const questions = new Map<string, Record<string, unknown>>();
  const plans = new Map<string, Record<string, unknown>>();
  const activeStreams = new Map<string, string>();
  const committedStreams = new Set<string>();
  const aliases = new Map<string, string>();
  const rows = new Map<string, { role: string; content: string; truncated?: boolean }>();
  // 终态按执行（runId）归属，挂在那次执行当时的最后一行下面：多次任务各行其是，
  // 不再按到达顺序堆在会话底部互相矛盾（build 40 真机：「任务已完成」和「没有完成」两行并列）。
  // **成功不挂行**（爸 2026-09-16 build 41 真机）：每一轮回复在协议上都是一次 run，成功就挂「任务已完成」
  // 等于闲聊「你好」下面也报一句任务完成——回复本身就是成功的证据。只有失败与被停止必须说，
  // 那两种沉默了用户不知道发生过什么。推送正文仍保留完成句：人在后台时需要那一下。
  const outcomes = new Map<string, RunOutcome>();
  let lastRow: string | undefined = history?.messages.at(-1)?.id;
  for (const message of history?.messages ?? []) rows.set(message.id, { role: message.role, content: message.content, truncated: message.truncated });
  for (const event of events) {
    if (event.sessionId !== sessionId) continue;
    const p = event.payload;
    if (event.kind === 'approval' && typeof p.requestId === 'string') approvals.set(p.requestId, { ...approvals.get(p.requestId), ...p });
    if (event.kind === 'question' && typeof p.requestId === 'string') questions.set(p.requestId, { ...questions.get(p.requestId), ...p });
    if (event.kind === 'plan' && typeof p.requestId === 'string') plans.set(p.requestId, { ...plans.get(p.requestId), ...p });
    const run = String(p.runId ?? sessionId);
    const id = `${run}:${String(p.id ?? p.messageId ?? p.turnId ?? event.eventId)}`;
    if (event.kind === 'message' && typeof p.content === 'string') {
      // The engine's durable message ID can differ from its streamed turn ID.
      const stream = p.role === 'assistant' ? activeStreams.get(run) : undefined;
      const durableId = String(p.id ?? p.messageId ?? event.eventId);
      const key = durableId;
      if (stream) rows.delete(stream);
      rows.set(key, { role: String(p.role), content: p.content });
      lastRow = key;
      if (stream) {
        aliases.set(id, key); aliases.set(stream, key); committedStreams.add(stream); committedStreams.add(key); activeStreams.delete(run);
        for (const outcome of outcomes.values()) if (outcome.anchor === stream) outcome.anchor = key;
      }
    } else if (event.kind === 'message_snapshot' || event.kind === 'message_delta') {
      const key = aliases.get(id) ?? id;
      if (committedStreams.has(key)) continue;
      if (event.kind === 'message_snapshot' && typeof p.content === 'string') {
        activeStreams.set(run, key); rows.set(key, { role: 'assistant', content: p.content }); lastRow = key;
      } else if (event.kind === 'message_delta' && typeof p.text === 'string') {
        activeStreams.set(run, key);
        const old = rows.get(key)?.content ?? '';
        rows.set(key, { role: 'assistant', content: p.op === 'append' ? old + p.text : p.text }); lastRow = key;
      }
    } else if (event.kind === 'agent_cancelled' || event.kind === 'error') {
      const kind = event.kind === 'agent_cancelled' ? 'stopped' : 'failed';
      // 同一次执行先报错再收尾时失败说了算：这次任务没有完成（agent_complete 不落行，也就抹不掉这条）。
      if (outcomes.get(run)?.kind !== 'failed') outcomes.set(run, { anchor: lastRow, kind, code: typeof p.code === 'string' ? p.code : undefined });
    }
  }
  const outcomesAt = (anchor: string | undefined) => Array.from(outcomes).filter(([, outcome]) => outcome.anchor === anchor)
    .map(([run, outcome]) => <p key={`outcome:${run}`} className="run-outcome" data-outcome={outcome.kind}>{runOutcomeCopy(text, outcome.kind, outcome.code)}</p>);
  return <div className="message-region"><div ref={scroller} onScroll={() => {
    const el = scroller.current!;
    following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setShowLatest(!following.current);
  }} className="lan-messages" aria-label={text.history} aria-live="polite">
    {history?.nextOffset != null && !offline && <button onClick={loadMore}>{text.loadHistory}</button>}
    {outcomesAt(undefined)}
    {Array.from(rows, ([id, row]) => <Fragment key={id}>{row.role === 'user'
      ? <p className="lan-message from-user">{row.content}{row.truncated && <small className="notice">{text.historyTruncated}</small>}</p>
      : <div className="lan-message">
        <div className="assistant-label"><NeoBrandMark variant="mark" size={24} /><span>{text.neo}</span></div>
        <p className="assistant-text">{row.content}{row.truncated && <small className="notice">{text.historyTruncated}</small>}</p>
      </div>}{outcomesAt(id)}</Fragment>)}
    {Array.from(approvals, ([id, card]) => (!hidePendingApprovals || card.status !== 'pending') && <ApprovalCard key={id} card={card} text={text} disabled={disabled}
      respond={decision => respond(id, decision)} />)}
    {Array.from(questions, ([id, card]) => (!hidePendingApprovals || card.status !== 'pending') && <QuestionCard key={id} card={card} text={text} disabled={disabled}
      respond={answers => respondQuestion(id, answers)} skip={reason => respondQuestion(id, {}, true, reason)} />)}
    {Array.from(plans, ([id, card]) => (!hidePendingApprovals || card.status !== 'pending') && <PlanCard key={id} card={card} text={text} disabled={disabled}
      respond={(decision, feedback) => respondPlan(id, decision, feedback)} />)}
    {(() => {
      // 「正在生成」只留还未完成的：tool_call_end 投影带同一 toolCallId 到达后即消失，
      // 不再长期挂在只增不减的 events 流里。
      const done = new Set(events.filter(e => e.kind === 'tool_call_end').map(e => String(e.payload.toolCallId)));
      return events.filter(event => event.sessionId === sessionId && event.kind === 'artifact_write_started'
        && !done.has(String(event.payload.toolCallId))).map(event =>
        <p key={event.eventId} className="notice">{text.artifactWriting} {String(event.payload.name ?? '')}</p>);
    })()}
    {artifacts.map(artifact => <button key={artifact.artifactId} className="artifact-card" disabled={disabled} onClick={() => openArtifact(artifact.artifactId)}>
      <strong>{artifact.name}</strong><span>{artifact.origin === 'upload' ? text.fromPhone : text.artifacts}</span>
    </button>)}
    {/* 执行条：一个呼吸点说「还活着」+ 一句在做什么。**不带停止按钮**——停止收进输入区那个键
        （N-MOBILE-SEND-IS-STOP）。它留在消息流里是为了说清「是哪一次执行在跑」，这是输入区
        那个键给不了的信息；但同一个动作不该有两个落点。 */}
    {running && <div className="run-strip" data-testid="run-strip"><span className="run-dot" aria-hidden="true" /><span>{text.running}</span></div>}
  </div>{showLatest && <button className="jump-latest" onClick={() => {
    following.current = true; scroller.current!.scrollTop = scroller.current!.scrollHeight; setShowLatest(false);
  }}>{text.latest} ↓</button>}</div>;
}
