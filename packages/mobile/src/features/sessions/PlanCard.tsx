import { useState } from 'react';
import type { messages } from '../../i18n';

type PlanPreview = { plan?: string; agentName?: string; risk?: { level?: string; reasons?: string[] } };

export function PlanCard({ card, text, disabled, respond }: {
  card: Record<string, unknown>;
  text: ReturnType<typeof messages>;
  disabled: boolean;
  respond: (decision: 'approved' | 'rejected', feedback?: string) => Promise<void>;
}) {
  let preview: PlanPreview | null = null;
  try { preview = JSON.parse(String(card.preview ?? '')) as PlanPreview; } catch { /* An unreadable plan cannot be approved. */ }
  const [feedback, setFeedback] = useState('');
  const readable = typeof preview?.plan === 'string' && preview.plan.trim().length > 0;
  const reasons = Array.isArray(preview?.risk?.reasons) ? preview.risk.reasons.filter((reason: string) => typeof reason === 'string') : [];

  return <section className="approval-card" aria-label={text.plan}>
    <strong>{text.plan}</strong>
    <div className="approval-details">
      {!readable && <p role="status">{text.unreadablePlan}</p>}
      {preview?.agentName && <p>{preview.agentName}</p>}
      {preview?.risk?.level && <p>{text.planRisk}: {preview.risk.level}</p>}
      {reasons.map(reason => <p key={reason} className="caption">{reason}</p>)}
      {readable && <pre>{preview!.plan}</pre>}
      {card.status === 'pending' && <label className="question-other">{text.planFeedback}
        <textarea
          value={feedback}
          disabled={disabled}
          placeholder={text.planFeedbackPlaceholder}
          onChange={event => setFeedback(event.target.value)}
        />
      </label>}
    </div>
    {card.status === 'pending' ? <div className="approval-actions">
      <button disabled={disabled} onClick={() => void respond('rejected', feedback.trim() || undefined)}>{text.planReject}</button>
      <button disabled={disabled || !readable} onClick={() => void respond('approved', feedback.trim() || undefined)}>{text.planApprove}</button>
    </div> : <p role="status" data-status={String(card.status)}>{card.status === 'approved' ? text.planApproved : card.status === 'rejected' ? text.planRejected : text.planClosed}</p>}
  </section>;
}
