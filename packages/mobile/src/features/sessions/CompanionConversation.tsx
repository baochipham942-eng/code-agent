import { ApprovalCard } from './ApprovalCard';
import type { CompanionEvent } from '../../../../../src/shared/contract/companion';
import type { messages } from '../../i18n';

export function CompanionConversation({ events, sessionId, text, disabled, respond }: { events: CompanionEvent[]; sessionId: string; text: ReturnType<typeof messages>; disabled: boolean; respond: (requestId: string, decision: 'approved' | 'rejected') => Promise<void> }) {
  const approvals = new Map<string, Record<string, unknown>>();
  const rows = new Map<string, { role: string; content: string }>();
  for (const event of events) {
    if (event.sessionId !== sessionId) continue;
    const p = event.payload;
    if (event.kind === 'approval' && typeof p.requestId === 'string') approvals.set(p.requestId, { ...approvals.get(p.requestId), ...p });
    const id = String(p.id ?? p.messageId ?? p.turnId ?? p.runId ?? event.eventId);
    if (event.kind === 'message' && typeof p.content === 'string') rows.set(id, { role: String(p.role), content: p.content });
    else if (event.kind === 'message_snapshot' && typeof p.content === 'string') rows.set(id, { role: 'assistant', content: p.content });
    else if (event.kind === 'message_delta' && typeof p.text === 'string') {
      const old = rows.get(id)?.content ?? '';
      rows.set(id, { role: 'assistant', content: p.op === 'append' ? old + p.text : p.text });
    }
  }
  return <div className="lan-messages" aria-label={text.history} aria-live="polite">
    {Array.from(rows, ([id, row]) => <p key={id} className={`lan-message ${row.role === 'user' ? 'from-user' : ''}`}>{row.content}</p>)}
    {Array.from(approvals, ([id, card]) => <ApprovalCard key={id} card={card} text={text} disabled={disabled}
      respond={decision => respond(id, decision)} />)}
  </div>;
}
