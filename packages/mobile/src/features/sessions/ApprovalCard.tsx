import type { messages } from '../../i18n';

export function ApprovalCard({ card, text, disabled, respond }: {
  card: Record<string, unknown>; text: ReturnType<typeof messages>; disabled: boolean;
  respond: (decision: 'approved' | 'rejected') => Promise<void>;
}) {
  type Preview = { details?: Record<string, unknown>; boundary?: unknown };
  let preview: Preview | null = null;
  try { preview = JSON.parse(String(card.preview ?? '')) as Preview; } catch { /* An unreadable operation cannot be approved. */ }
  const labels: Record<string, string> = {
    path: text.targetPath, filePath: text.targetPath, affectedPath: text.targetPath,
    command: text.commandPreview, url: text.targetUrl, oldContent: text.beforeChange, newContent: text.afterChange,
    changes: text.changePreview, preview: text.changePreview, server: text.targetService, toolName: text.targetOperation,
    commandRiskLevel: text.operationRisk, commandSecurityFlags: text.operationRisk, affectedFileCount: text.affectedFiles,
    targetKind: text.targetKind, standingGrantTarget: text.targetOperation, requestedAccess: text.requestedAccess,
  };
  const value = (input: unknown) => typeof input === 'string' ? input : JSON.stringify(input, null, 2);
  const readable = preview?.details && typeof preview.details === 'object' && !Array.isArray(preview.details);
  return <section className="approval-card" aria-label={text.approval}>
    <strong>{text.approval}</strong>
    {readable && Object.entries(preview?.details ?? {}).map(([key, detail]) => <div key={key}><p>{labels[key] ?? text.otherDetails}</p><pre>{value(detail)}</pre></div>)}
    {preview?.boundary !== undefined && <div><p>{text.dataBoundary}</p><pre>{value(preview.boundary)}</pre></div>}
    {card.status === 'pending' ? <div className="approval-actions">
      <button disabled={disabled} onClick={() => void respond('rejected')}>{text.deny}</button>
      <button disabled={disabled || !readable} onClick={() => void respond('approved')}>{text.approveOnce}</button>
    </div> : <p role="status">{text.approvalClosed}</p>}
  </section>;
}
