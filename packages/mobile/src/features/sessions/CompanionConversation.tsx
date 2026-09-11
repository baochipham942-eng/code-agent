import type { CompanionArtifact, CompanionHistory } from '../../../../../src/shared/contract/companionLibrary';
import { useLayoutEffect, useRef, useState } from 'react';
import { ApprovalCard } from './ApprovalCard';
import type { CompanionEvent } from '../../../../../src/shared/contract/companion';
import type { messages } from '../../i18n';

export function CompanionConversation({ history, loadMore, hidePendingApprovals = false, events, artifacts, sessionId, text, disabled, respond, openArtifact }: { history?: CompanionHistory; loadMore(): void; hidePendingApprovals?: boolean; events: CompanionEvent[]; artifacts: CompanionArtifact[]; sessionId: string; text: ReturnType<typeof messages>; disabled: boolean; respond: (requestId: string, decision: 'approved' | 'rejected') => Promise<void>; openArtifact(id: string): void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  useLayoutEffect(() => { following.current = true; setShowLatest(false); }, [sessionId]);
  useLayoutEffect(() => {
    if (following.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [events, sessionId, history]);
  const approvals = new Map<string, Record<string, unknown>>();
  const activeStreams = new Map<string, string>();
  const committedStreams = new Set<string>();
  const aliases = new Map<string, string>();
  const rows = new Map<string, { role: string; content: string; truncated?: boolean }>();
  for (const message of history?.messages ?? []) rows.set(message.id, { role: message.role, content: message.content, truncated: message.truncated });
  for (const event of events) {
    if (event.sessionId !== sessionId) continue;
    const p = event.payload;
    if (event.kind === 'approval' && typeof p.requestId === 'string') approvals.set(p.requestId, { ...approvals.get(p.requestId), ...p });
    const run = String(p.runId ?? sessionId);
    const id = `${run}:${String(p.id ?? p.messageId ?? p.turnId ?? event.eventId)}`;
    if (event.kind === 'message' && typeof p.content === 'string') {
      // The engine's durable message ID can differ from its streamed turn ID.
      const stream = p.role === 'assistant' ? activeStreams.get(run) : undefined;
      const durableId = String(p.id ?? p.messageId ?? event.eventId);
      const key = durableId;
      if (stream) rows.delete(stream);
      rows.set(key, { role: String(p.role), content: p.content });
      if (stream) { aliases.set(id, key); aliases.set(stream, key); committedStreams.add(stream); committedStreams.add(key); activeStreams.delete(run); }
    } else if (event.kind === 'message_snapshot' || event.kind === 'message_delta') {
      const key = aliases.get(id) ?? id;
      if (committedStreams.has(key)) continue;
      if (event.kind === 'message_snapshot' && typeof p.content === 'string') {
        activeStreams.set(run, key); rows.set(key, { role: 'assistant', content: p.content });
      } else if (event.kind === 'message_delta' && typeof p.text === 'string') {
        activeStreams.set(run, key);
        const old = rows.get(key)?.content ?? '';
        rows.set(key, { role: 'assistant', content: p.op === 'append' ? old + p.text : p.text });
      }
    }
  }
  return <div className="message-region"><div ref={scroller} onScroll={() => {
    const el = scroller.current!;
    following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setShowLatest(!following.current);
  }} className="lan-messages" aria-label={text.history} aria-live="polite">
    {history?.nextOffset != null && <button onClick={loadMore}>{text.loadHistory}</button>}
    {Array.from(rows, ([id, row]) => <p key={id} className={`lan-message ${row.role === 'user' ? 'from-user' : ''}`}>{row.content}{row.truncated && <small className="notice">{text.historyTruncated}</small>}</p>)}
    {Array.from(approvals, ([id, card]) => (!hidePendingApprovals || card.status !== 'pending') && <ApprovalCard key={id} card={card} text={text} disabled={disabled}
      respond={decision => respond(id, decision)} />)}
    {(() => {
      // 「正在生成」只留还未完成的：tool_call_end 投影带同一 toolCallId 到达后即消失，
      // 不再长期挂在只增不减的 events 流里。
      const done = new Set(events.filter(e => e.kind === 'tool_call_end').map(e => String(e.payload.toolCallId)));
      return events.filter(event => event.sessionId === sessionId && event.kind === 'artifact_write_started'
        && !done.has(String(event.payload.toolCallId))).map(event =>
        <p key={event.eventId} className="notice">{text.artifactWriting} {String(event.payload.name ?? '')}</p>);
    })()}
    {artifacts.map(artifact => <button key={artifact.artifactId} className="artifact-card" disabled={disabled} onClick={() => openArtifact(artifact.artifactId)}>
      <strong>{artifact.name}</strong><span>{artifact.origin === 'upload' ? text.attach : text.artifacts}</span>
    </button>)}
  </div>{showLatest && <button className="jump-latest" onClick={() => {
    following.current = true; scroller.current!.scrollTop = scroller.current!.scrollHeight; setShowLatest(false);
  }}>{text.latest} ↓</button>}</div>;
}
