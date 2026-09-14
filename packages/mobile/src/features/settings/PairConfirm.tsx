import { formatInvitationVerify } from '../../../../../src/shared/companion/lanProtocol';
import type { messages } from '../../i18n';

export function PairConfirm({ name, verify, text, onConfirm, onReject }: {
  name: string;
  verify: string;
  text: ReturnType<typeof messages>;
  onConfirm(): void;
  onReject(): void;
}) {
  return <div className="pair-confirm" data-testid="pair-confirm">
    <h3>{text.pairConfirmTitle}</h3>
    <p className="caption">{text.pairConfirmHint}</p>
    <div className="pair-device"><strong>{name}</strong></div>
    <p className="pair-code" data-testid="pair-verify">{formatInvitationVerify(verify)}</p>
    <p className="caption">{text.pairConfirmVerify}</p>
    <button className="primary" onClick={onConfirm}>{text.pairConfirmContinue}</button>
    <button onClick={onReject}>{text.pairConfirmReject}</button>
  </div>;
}
