import type { CompanionArtifact, CompanionHistory } from '../../../../../src/shared/contract/companionLibrary';
import { Fragment, useLayoutEffect, useRef, useState } from 'react';
import { NeoBrandMark } from '../brand/NeoBrandMark';
import { ApprovalCard } from './ApprovalCard';
import { QuestionCard } from './QuestionCard';
import { PlanCard } from './PlanCard';
import { Markdown } from './markdown/Markdown';
import type { CompanionEvent } from '../../../../../src/shared/contract/companion';
import { runOutcomeCopy, type messages } from '../../i18n';

type RunOutcome = { anchor: string | undefined; kind: 'stopped' | 'failed'; code?: string; provider?: string; model?: string };

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

export function CompanionConversation({ history, loadMore, hidePendingApprovals = false, events, artifacts, sessionId, text, disabled, respond, respondQuestion, respondPlan, openArtifact, composerHeight = 0, offline = false, running = null, openModel, sessionModel, models }: { history?: CompanionHistory; loadMore(): void; hidePendingApprovals?: boolean; events: CompanionEvent[]; artifacts: CompanionArtifact[]; sessionId: string; text: ReturnType<typeof messages>; disabled: boolean; respond: (requestId: string, decision: 'approved' | 'rejected') => Promise<void>; respondQuestion: (requestId: string, answers: Record<string, string | string[]>, declined?: boolean, reason?: string) => Promise<void>; respondPlan: (requestId: string, decision: 'approved' | 'rejected', feedback?: string) => Promise<void>; openArtifact(id: string): void;
  /** 输入区那一层的实测高度：它一变，滚动区的底部内边距跟着变，贴底的人得重新贴一次。 */
  composerHeight?: number;
  /** Offline reread: hide load-more (it cannot fetch) without changing the composer. */
  offline?: boolean;
  /**
   * 这条会话正在电脑上跑：最后一条下面给执行条。null = 没在跑，执行条不渲染（任务一结束就消失）。
   *
   * `stop` **可选**：停止的正常落点是输入区那个键（N-MOBILE-SEND-IS-STOP），执行条只说
   * 「哪一次在跑」。只有输入区被录音面板整块顶掉、那个键此刻不存在时，调用方才把 stop 交给
   * 执行条——否则同一个动作会有两个落点。不传就不渲染按钮（grok ai-review PR#1903 Nit①②）。
   */
  running?: { stop?(): void; stopDisabled?: boolean } | null;
  /** 打开「选择会话模型」。模型密钥用不了 / 模型停用的失败态靠它给出路。 */
  openModel?(): void;
  /** 这条会话下一次执行会用的模型。失败的那个模型已经被换掉，就不再挂「换一个可用模型」。 */
  sessionModel?: { provider: string; model: string } | null;
  /** 用来把失败卡片里的模型 id 换成列表上的显示名。 */
  models?: { provider: string; model: string; label: string }[] }) {
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
  // 流式行第一次出现时的事件时间：冷启动重放去重要用它判断「这半段是不是在流开始之后才落库的」。
  const streamStarts = new Map<string, number>();
  const aliases = new Map<string, string>();
  const rows = new Map<string, { role: string; content: string; truncated?: boolean; queued?: boolean }>();
  // 终态按执行（runId）归属，挂在那次执行当时的最后一行下面：多次任务各行其是，
  // 不再按到达顺序堆在会话底部互相矛盾（build 40 真机：「任务已完成」和「没有完成」两行并列）。
  // **成功不挂行**（爸 2026-09-16 build 41 真机）：每一轮回复在协议上都是一次 run，成功就挂「任务已完成」
  // 等于闲聊「你好」下面也报一句任务完成——回复本身就是成功的证据。只有失败与被停止必须说，
  // 那两种沉默了用户不知道发生过什么。推送正文仍保留完成句：人在后台时需要那一下。
  const outcomes = new Map<string, RunOutcome>();
  // 审批/提问/计划卡按**第一次出现**时的最后一行挂载，和执行结果同一套锚点（爸 2026-09-16 真机：
  // 卡片原来统一画在全部消息之后，后到的回复跑到卡片上面，看着像先写了产物才回复）。
  const cardAnchors = new Map<string, string | undefined>();
  let lastRow: string | undefined = history?.messages.at(-1)?.id;
  let latestRun: string | undefined;
  // 历史行的宿主时间（和事件 createdAt 是同一台电脑的钟）。事件生出来的新行不记：它们只会排在历史之后，按到达顺序挂就对。
  const stamps = new Map<string, number>();
  for (const message of history?.messages ?? []) {
    rows.set(message.id, { role: message.role, content: message.content, truncated: message.truncated, queued: message.queued === true });
    stamps.set(message.id, message.timestamp);
  }
  /**
   * 卡片与执行结果挂在「它发生时的最后一行」下面（FB-177）。实时路径事件按发生顺序到，lastRow 就是那一行。
   * 冷启动不是：本机缓存的卡片排在 events 最前面，历史先整页铺好，处理到卡片时 lastRow 已经是会话最后一行，
   * 卡片就全堆到末尾。事件比 lastRow 发生得早，就按时间落回：挂在第一条比它晚的行前面。
   * 早于已加载的全部行（历史分页还没翻到）则挂在最前面，loadMore 之后重算。
   */
  const anchorAt = (at: number): string | undefined => {
    const lastStamp = lastRow === undefined ? undefined : stamps.get(lastRow);
    if (lastStamp === undefined || at >= lastStamp) return lastRow;
    let anchor: string | undefined;
    for (const id of rows.keys()) {
      if ((stamps.get(id) ?? -Infinity) > at) break;
      anchor = id;
    }
    return anchor;
  };
  for (const event of events) {
    if (event.sessionId !== sessionId) continue;
    const p = event.payload;
    if (event.kind === 'approval' && typeof p.requestId === 'string') approvals.set(p.requestId, { ...approvals.get(p.requestId), ...p });
    if (event.kind === 'question' && typeof p.requestId === 'string') questions.set(p.requestId, { ...questions.get(p.requestId), ...p });
    if (event.kind === 'plan' && typeof p.requestId === 'string') plans.set(p.requestId, { ...plans.get(p.requestId), ...p });
    if ((event.kind === 'approval' || event.kind === 'question' || event.kind === 'plan') && typeof p.requestId === 'string'
      && !cardAnchors.has(`${event.kind}:${p.requestId}`)) cardAnchors.set(`${event.kind}:${p.requestId}`, anchorAt(event.createdAt));
    const run = String(p.runId ?? sessionId);
    latestRun = run;
    const id = `${run}:${String(p.id ?? p.messageId ?? p.turnId ?? event.eventId)}`;
    if (event.kind === 'message' && typeof p.content === 'string') {
      // The engine's durable message ID can differ from its streamed turn ID.
      const stream = p.role === 'assistant' ? activeStreams.get(run) : undefined;
      const durableId = String(p.id ?? p.messageId ?? event.eventId);
      const key = durableId;
      if (stream) rows.delete(stream);
      rows.set(key, { role: String(p.role), content: p.content, queued: p.queued === true });
      lastRow = key;
      if (stream) {
        aliases.set(id, key); aliases.set(stream, key); committedStreams.add(stream); committedStreams.add(key); activeStreams.delete(run);
        for (const outcome of outcomes.values()) if (outcome.anchor === stream) outcome.anchor = key;
        for (const [card, anchor] of cardAnchors) if (anchor === stream) cardAnchors.set(card, key);
      }
    } else if (event.kind === 'message_snapshot' || event.kind === 'message_delta') {
      const key = aliases.get(id) ?? id;
      if (committedStreams.has(key)) continue;
      if (!streamStarts.has(key)) streamStarts.set(key, event.createdAt);
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
      const failedModel = typeof p.provider === 'string' && typeof p.model === 'string' ? { provider: p.provider, model: p.model } : {};
      const existing = outcomes.get(run);
      if (existing?.kind !== 'failed') outcomes.set(run, { anchor: anchorAt(event.createdAt), kind, code: typeof p.code === 'string' ? p.code : undefined, ...failedModel });
      // 电脑对同一次失败会从两个出口各发一条 error，只有一条带着失败的模型（远端验收实测 seq 36 带、37 不带）；
      // 按到达顺序取第一条的话，顺序一反卡片就收不起来。哪条带就补哪条。
      else if (!existing.provider && 'provider' in failedModel) Object.assign(existing, failedModel);
    }
  }
  /**
   * 冷启动重放去重（2026-09-17 R4 模拟器验收 D2）：插话或点停止打断的流，宿主会把已吐出的半段落库
   * （conversationRuntime.preserveStreamedPartial，正文尾巴带 [已被新消息打断]/[cancelled] 类标记，
   * 出手机边界前剥掉），但**不发终结 message 事件**——重放时 delta 堆出来的流式行没人收编，就成了一条
   * 追在会话末尾的重复段（实时 6 行、冷启动 8 行，DB 只有 6 条）。落库半段拿的是**新 id**，与流的
   * turnId 对不上号，只能按内容对齐：流式行内容 === 历史助手消息内容（标记剥掉后就是半段原文），
   * 或历史侧被 64k 截成了前缀；并要求这条历史消息不早于流的第一个事件，防把仍在生成的流错配到
   * 更早的同文消息上（同一个模型每轮开头常是同一句话）。删行时把挂在它下面的执行结果与卡片
   * 迁回那条历史行——与实时路径 message 事件收编流式行（上面的 aliases/committedStreams）同一套搬家。
   */
  for (const [key, startedAt] of streamStarts) {
    if (committedStreams.has(key)) continue;
    const streamed = rows.get(key);
    if (!streamed) continue;
    const persisted = (history?.messages ?? []).find(message => message.role === 'assistant' && message.content.trim()
      && message.timestamp >= startedAt && (message.content === streamed.content || streamed.content.startsWith(message.content)));
    if (!persisted) continue;
    rows.delete(key);
    for (const outcome of outcomes.values()) if (outcome.anchor === key) outcome.anchor = persisted.id;
    for (const [card, anchor] of cardAnchors) if (anchor === key) cardAnchors.set(card, persisted.id);
  }
  /**
   * 失败态要带出路（爸 2026-09-16）：模型密钥用不了是用户当场能绕过去的，在**最近那次**失败下面给
   * 「换一个可用模型」直达模型选择。只挂在会话里最近那次执行上：之后又跑过（哪怕成功了）就说明已经绕过去了，
   * 每条旧失败都挂一个按钮是噪音。
   */
  // 爸 2026-09-16 真机：已经换成能用的模型，卡片还挂着。失败事件带着那次跑的模型，当前模型不是它就收起；
  // 换回同一个坏模型会再出现。旧宿主不带模型时照旧显示。
  const switchedAway = (outcome: RunOutcome) => Boolean(outcome.provider && sessionModel
    && (sessionModel.provider !== outcome.provider || sessionModel.model !== outcome.model));
  const modelCard = (outcome: RunOutcome) => outcome.code === 'MODEL_AUTH' || outcome.code === 'MODEL_UNAVAILABLE' || outcome.code === 'MODEL_QUOTA';
  const modelName = (outcome: RunOutcome) => models?.find(item => item.provider === outcome.provider && item.model === outcome.model)?.label
    ?? outcome.model ?? '';
  const outcomesAt = (anchor: string | undefined) => Array.from(outcomes).filter(([, outcome]) => outcome.anchor === anchor)
    .map(([run, outcome]) => {
      const showCard = run === latestRun && modelCard(outcome) && Boolean(openModel) && !switchedAway(outcome);
      return <Fragment key={`outcome:${run}`}>
        {!showCard && <p className="run-outcome" data-outcome={outcome.kind}>{runOutcomeCopy(text, outcome.kind, outcome.code)}</p>}
        {showCard && <div className="decision" data-testid={outcome.code === 'MODEL_UNAVAILABLE' ? 'model-unavailable' : outcome.code === 'MODEL_QUOTA' ? 'model-quota-failed' : 'model-auth-failed'}>
          {outcome.code === 'MODEL_UNAVAILABLE'
            ? <><h3>{text.modelGoneTitle}</h3><p>{text.modelGoneDetail.replace('{model}', modelName(outcome))}</p></>
            : outcome.code === 'MODEL_QUOTA'
              ? <><h3>{text.modelQuotaTitle}</h3><p>{text.modelQuotaDetail}</p></>
              : <><h3>{text.modelAuthTitle}</h3><p>{text.modelAuthDetail}</p></>}
          <button className="primary" onClick={openModel}>{text.switchModel}</button>
        </div>}
      </Fragment>;
    });
  const cardsAt = (anchor: string | undefined) => <>
    {Array.from(approvals, ([id, card]) => cardAnchors.get(`approval:${id}`) === anchor && (!hidePendingApprovals || card.status !== 'pending') && <ApprovalCard key={id} card={card} text={text} disabled={disabled}
      respond={decision => respond(id, decision)} />)}
    {Array.from(questions, ([id, card]) => cardAnchors.get(`question:${id}`) === anchor && (!hidePendingApprovals || card.status !== 'pending') && <QuestionCard key={id} card={card} text={text} disabled={disabled}
      respond={answers => respondQuestion(id, answers)} skip={reason => respondQuestion(id, {}, true, reason)} />)}
    {Array.from(plans, ([id, card]) => cardAnchors.get(`plan:${id}`) === anchor && (!hidePendingApprovals || card.status !== 'pending') && <PlanCard key={id} card={card} text={text} disabled={disabled}
      respond={(decision, feedback) => respondPlan(id, decision, feedback)} />)}
  </>;
  // Neo 头一段只画一次（爸 09-17 拍板 ③A）：以用户消息为界，只在其后第一段有正文的助手行上画。
  // 中间隔着卡片、执行结果、第二次执行都不重画——只看上一条**可见**消息是不是用户，历史与实时共用这一份 rows。
  const labelled = new Set<string>();
  let afterUser = true;
  for (const [id, row] of rows) {
    if (row.role === 'user') afterUser = true;
    else if (row.content.trim() && afterUser) { labelled.add(id); afterUser = false; }
  }
  return <div className="message-region"><div ref={scroller} onScroll={() => {
    const el = scroller.current!;
    following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setShowLatest(!following.current);
  }} className="lan-messages" aria-label={text.history} aria-live="polite">
    {history?.nextOffset != null && !offline && <button onClick={loadMore}>{text.loadHistory}</button>}
    {outcomesAt(undefined)}{cardsAt(undefined)}
    {Array.from(rows, ([id, row]) => <Fragment key={id}>{row.role === 'user'
      ? <p className="lan-message from-user">{row.content}{row.truncated && <small className="notice">{text.historyTruncated}</small>}{row.queued && <small className="notice" data-testid="supplement-queued">{text.supplementQueued}</small>}</p>
      // 正文为空的助手消息是只调了工具的那一轮（派子助手、读文件），手机不显示工具步骤，画出来就是空气泡（爸 2026-09-16 真机）。
      // 行本身不画，但挂在它下面的执行结果和卡片照常画。
      : !row.content.trim() ? null : <div className="lan-message">
        {labelled.has(id) && <div className="assistant-label"><NeoBrandMark variant="mark" size={24} /><span>{text.neo}</span></div>}
        <div className="assistant-text md"><Markdown source={row.content} copyLabel={text.copy} copiedLabel={text.copied} />{row.truncated && <small className="notice">{text.historyTruncated}</small>}</div>
      </div>}{outcomesAt(id)}{cardsAt(id)}</Fragment>)}
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
    {/* 执行条：一个呼吸点说「还活着」+ 一句在做什么。平时**不带停止按钮**——停止收进输入区
        那个键（N-MOBILE-SEND-IS-STOP）。它留在消息流里是为了说清「是哪一次执行在跑」，这是
        输入区那个键给不了的信息；但同一个动作不该有两个落点。
        例外只有一个：录音面板把输入区整块顶掉时那个键不存在，停止在这里接回来，否则运行中
        一开录音就没法停任务（grok ai-review PR#1903 Nit①）。 */}
    {running && <div className="run-strip" data-testid="run-strip"><span className="run-dot" aria-hidden="true" /><span>{text.running}</span>
      {running.stop && <button disabled={running.stopDisabled} onClick={running.stop}>{text.stop}</button>}</div>}
  </div>{showLatest && <button className="jump-latest" onClick={() => {
    following.current = true; scroller.current!.scrollTop = scroller.current!.scrollHeight; setShowLatest(false);
  }}>{text.latest} ↓</button>}</div>;
}
