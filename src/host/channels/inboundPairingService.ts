import { randomInt, randomUUID } from 'crypto';
import type { PermissionResponse } from '../../shared/contract';
import type { InboundAccessLocale } from './inboundAccessI18n';
import { inboundAccessText } from './inboundAccessI18n';
import { getDatabase } from '../services/core/databaseService';
import type { PendingApprovalRepository } from '../services/core/repositories/PendingApprovalRepository';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('InboundPairingService');

const INBOUND_PAIRING_CODE_DIGITS = 6;
const INBOUND_PAIRING_TTL_MS = 10 * 60 * 1000;
// A Feishu/Lark app should expose only a small desktop review queue, even when senders rotate.
const MAX_PENDING_PAIRINGS_PER_ACCOUNT = 5;
// Ten replies covers five requests plus five desktop decisions without allowing an unbounded reply flood.
const MAX_PAIRING_REPLIES_PER_ACCOUNT_PER_MINUTE = 10;
const PAIRING_REPLY_RATE_WINDOW_MS = 60 * 1000;

export interface InboundPairingRequest {
  accountId: string;
  accountScopeId: string;
  channelType: 'feishu' | 'lark';
  senderId: string;
  senderName: string;
  chatId: string;
  replyToMessageId?: string;
  locale?: InboundAccessLocale;
}

export interface InboundPairingAdapter {
  addPairedSender(accountId: string, senderId: string): boolean;
  sendControlReply(
    accountId: string,
    chatId: string,
    replyToMessageId: string | undefined,
    content: string,
  ): Promise<void>;
}

interface PendingPairing extends InboundPairingRequest {
  id: string;
  code: string;
  requestedAt: number;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

interface ReplyRateWindow {
  startedAt: number;
  count: number;
}

interface InboundPairingServiceDeps {
  now?: () => number;
  generateCode?: () => string;
  getRepository?: () => PendingApprovalRepository;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
}

export class InboundPairingService {
  private readonly pendingById = new Map<string, PendingPairing>();
  private readonly pendingIdBySender = new Map<string, string>();
  private readonly replyRateByAccount = new Map<string, ReplyRateWindow>();
  private adapter: InboundPairingAdapter | null = null;
  private readonly now: () => number;
  private readonly generateCode: () => string;
  private readonly getRepository: () => PendingApprovalRepository;
  private readonly setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;

  constructor(deps: InboundPairingServiceDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.generateCode = deps.generateCode ?? (() => randomInt(0, 10 ** INBOUND_PAIRING_CODE_DIGITS).toString().padStart(INBOUND_PAIRING_CODE_DIGITS, '0'));
    this.getRepository = deps.getRepository ?? (() => getDatabase().getPendingApprovalRepo());
    this.setTimer = deps.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  }

  configureAdapter(adapter: InboundPairingAdapter): void {
    this.adapter = adapter;
  }

  async request(input: InboundPairingRequest): Promise<string | null> {
    const senderKey = this.senderKey(input);
    const previousId = this.pendingIdBySender.get(senderKey);
    const previous = previousId ? this.pendingById.get(previousId) : undefined;
    if (previous && previous.expiresAt > this.now()) {
      await this.reply(previous, inboundAccessText(previous.locale, 'pairing', previous.code, INBOUND_PAIRING_TTL_MS / 60_000));
      return previous.code;
    }
    if (previous) this.expire(previous.id);

    const pendingCount = this.activePendingCount(input.accountScopeId);
    if (pendingCount >= MAX_PENDING_PAIRINGS_PER_ACCOUNT) {
      logger.warn('Rejected inbound pairing request: pending account limit reached', {
        accountId: input.accountId,
        accountScopeId: input.accountScopeId,
        senderId: input.senderId,
        pendingCount,
        limit: MAX_PENDING_PAIRINGS_PER_ACCOUNT,
      });
      return null;
    }

    const requestedAt = this.now();
    const id = `channel-pairing:${randomUUID()}`;
    const code = this.generateCode();
    const timer = this.setTimer(() => this.expire(id), INBOUND_PAIRING_TTL_MS);
    timer.unref?.();
    const pending: PendingPairing = {
      ...input,
      id,
      code,
      requestedAt,
      expiresAt: requestedAt + INBOUND_PAIRING_TTL_MS,
      timer,
    };
    this.pendingById.set(id, pending);
    this.pendingIdBySender.set(senderKey, id);
    this.getRepository().insert({
      id,
      kind: 'channel_pairing',
      agentId: null,
      agentName: null,
      coordinatorId: null,
      payload: {
        accountId: input.accountId,
        accountScopeId: input.accountScopeId,
        channelType: input.channelType,
        senderId: input.senderId,
        senderName: input.senderName,
        chatId: input.chatId,
        code,
        requestedAt,
        expiresAt: pending.expiresAt,
      },
      submittedAt: requestedAt,
    });
    await this.reply(pending, inboundAccessText(input.locale, 'pairing', code, INBOUND_PAIRING_TTL_MS / 60_000));
    return code;
  }

  resolve(requestId: string, response: PermissionResponse): boolean {
    const pending = this.pendingById.get(requestId);
    if (!pending) return false;
    if (pending.expiresAt <= this.now()) {
      this.expire(requestId);
      return false;
    }

    this.removePending(pending);
    const approved = response === 'allow' || response === 'allow_standing';
    const persisted = approved && this.adapter?.addPairedSender(pending.accountId, pending.senderId) === true;
    this.getRepository().resolve({
      id: requestId,
      status: persisted ? 'approved' : 'rejected',
      feedback: persisted ? 'Approved in desktop review inbox' : 'Rejected in desktop review inbox',
      resolvedAt: this.now(),
    });
    void this.reply(
      pending,
      inboundAccessText(pending.locale, persisted ? 'paired' : 'unauthorized'),
    );
    return true;
  }

  private expire(requestId: string): void {
    const pending = this.pendingById.get(requestId);
    if (!pending) return;
    this.removePending(pending);
    this.getRepository().resolve({
      id: requestId,
      status: 'rejected',
      feedback: 'Pairing code expired',
      resolvedAt: this.now(),
    });
    void this.reply(pending, inboundAccessText(pending.locale, 'unauthorized'));
  }

  private removePending(pending: PendingPairing): void {
    clearTimeout(pending.timer);
    this.pendingById.delete(pending.id);
    this.pendingIdBySender.delete(this.senderKey(pending));
  }

  private async reply(pending: InboundPairingRequest, content: string): Promise<void> {
    if (!this.takeReplySlot(pending)) return;
    if (!this.adapter) {
      logger.error('Inbound pairing adapter is not configured');
      return;
    }
    try {
      await this.adapter.sendControlReply(
        pending.accountId,
        pending.chatId,
        pending.replyToMessageId,
        content,
      );
    } catch (error) {
      logger.error('Failed to send inbound pairing control reply', { error });
    }
  }

  private activePendingCount(accountScopeId: string): number {
    let count = 0;
    for (const pending of this.pendingById.values()) {
      if (pending.accountScopeId !== accountScopeId) continue;
      if (pending.expiresAt <= this.now()) {
        this.expire(pending.id);
      } else {
        count += 1;
      }
    }
    return count;
  }

  private takeReplySlot(pending: InboundPairingRequest): boolean {
    const now = this.now();
    const current = this.replyRateByAccount.get(pending.accountScopeId);
    const window = !current || now - current.startedAt >= PAIRING_REPLY_RATE_WINDOW_MS
      ? { startedAt: now, count: 0 }
      : current;
    this.replyRateByAccount.set(pending.accountScopeId, window);
    if (window.count >= MAX_PAIRING_REPLIES_PER_ACCOUNT_PER_MINUTE) {
      logger.warn('Dropped inbound pairing reply: account rate limit reached', {
        accountId: pending.accountId,
        accountScopeId: pending.accountScopeId,
        senderId: pending.senderId,
        limit: MAX_PAIRING_REPLIES_PER_ACCOUNT_PER_MINUTE,
        windowMs: PAIRING_REPLY_RATE_WINDOW_MS,
      });
      return false;
    }
    window.count += 1;
    return true;
  }

  private senderKey(input: InboundPairingRequest): string {
    return `${input.accountScopeId}:${input.senderId}`;
  }
}

let instance: InboundPairingService | null = null;

export function getInboundPairingService(): InboundPairingService {
  instance ??= new InboundPairingService();
  return instance;
}
