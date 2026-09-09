import type { CompanionEvent } from '../../../../../src/shared/contract/companion';
import type { messages } from '../../i18n';

export function CompanionConversation({ events, sessionId, text }: { events: CompanionEvent[]; sessionId: string; text: ReturnType<typeof messages> }) {
  const rows = new Map<string, { role: string; content: string }>();
  for (const event of events) {
    if (event.sessionId !== sessionId) continue;
    const p = event.payload;
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
  </div>;
}
