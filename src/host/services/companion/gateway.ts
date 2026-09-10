type CommandScope = { projectId: string; sessionId: string; deviceId: string };
type Command = CommandScope & { commandId: string; kind: 'send' | 'stop'; payload?: string };
type Receipt = { commandId: string; accepted: boolean; status: 'accepted' | 'duplicate' | 'rejected'; reason?: string };
type Approval = CommandScope & { approvalId: string; revision: number; decision?: 'approved' | 'rejected' };

export class CompanionGateway {
  private readonly receipts = new Map<string, Receipt>();
  private readonly approvals = new Map<string, Approval>();
  private readonly revoked = new Set<string>();

  revoke(deviceId: string): void { this.revoked.add(deviceId); }

  receive(command: Command): Receipt {
    const previous = this.receipts.get(command.commandId);
    if (previous) return { ...previous, status: 'duplicate' };
    if (this.revoked.has(command.deviceId)) return this.remember({ commandId: command.commandId, accepted: false, status: 'rejected', reason: 'REVOKED' });
    if (!command.projectId || !command.sessionId || !command.deviceId) return this.remember({ commandId: command.commandId, accepted: false, status: 'rejected', reason: 'INVALID_SCOPE' });
    return this.remember({ commandId: command.commandId, accepted: true, status: 'accepted' });
  }

  beginApproval(input: Omit<Approval, 'decision'>): Approval {
    if (this.revoked.has(input.deviceId)) throw new Error('REVOKED');
    const key = this.approvalKey(input);
    const current = this.approvals.get(key);
    if (current && input.revision <= current.revision) throw new Error('STALE_REVISION');
    const next = { ...input };
    this.approvals.set(key, next);
    return { ...next };
  }

  decide(input: Approval, decision: 'approved' | 'rejected'): Approval {
    if (this.revoked.has(input.deviceId)) throw new Error('REVOKED');
    const key = this.approvalKey(input);
    const current = this.approvals.get(key);
    if (!current || current.approvalId !== input.approvalId || current.revision !== input.revision) throw new Error('STALE_REVISION');
    if (current.decision) throw new Error('ALREADY_DECIDED');
    const decided = { ...current, decision };
    this.approvals.set(key, decided);
    return { ...decided };
  }

  getReceipt(commandId: string): Receipt | undefined { const value = this.receipts.get(commandId); return value && { ...value }; }
  getApproval(scope: CommandScope): Approval | undefined { const value = this.approvals.get(this.approvalKey(scope)); return value && { ...value }; }
  private remember(receipt: Receipt): Receipt { this.receipts.set(receipt.commandId, receipt); return { ...receipt }; }
  private approvalKey(scope: Pick<CommandScope, 'projectId' | 'sessionId'>): string { return `${scope.projectId}\0${scope.sessionId}`; }
}
