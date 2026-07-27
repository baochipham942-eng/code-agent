import { randomUUID } from 'node:crypto';

import type { ExternalAgentEngineKind } from '../../../../shared/contract/agentEngine';
import type {
  SessionForkContextHandoffRecord,
  SessionForkContextSource,
} from '../../core/repositories/SessionForkRepository';
import {
  buildValidatedExternalForkContextHandoff,
  ExternalForkContextError,
  type ExternalForkContextHandoff,
  type ExternalForkContextPolicy,
} from './externalForkContextHandoff';

export interface SessionForkRuntimeContextDatabase {
  getSessionForkContextSource(childSessionId: string): SessionForkContextSource | null;
  getSessionForkContextHandoff?(
    forkId: string,
  ): SessionForkContextHandoffRecord | null;
  getDb?(): {
    prepare(sql: string): {
      get(...params: unknown[]): unknown;
    };
  } | null;
  prepareSessionForkContextHandoff(
    forkId: string,
    engine: ExternalAgentEngineKind,
    payloadDigest: string,
    preparedAt?: number,
  ): SessionForkContextHandoffRecord;
  markSessionForkContextHandoffDispatching(
    forkId: string,
    payloadDigest: string,
    attemptId: string,
    startedAt?: number,
  ): SessionForkContextHandoffRecord;
  markSessionForkContextHandoffConsumed(
    forkId: string,
    payloadDigest: string,
    attemptId: string,
    consumedAt?: number,
  ): SessionForkContextHandoffRecord;
}

export interface PrepareFirstChildRunInput {
  childSessionId: string;
  engine: ExternalAgentEngineKind;
  firstUserPrompt: string;
  policy: ExternalForkContextPolicy;
}

export interface PreparedSessionForkRuntimeContext {
  handoff: ExternalForkContextHandoff;
  attemptId: string;
  onDispatchStart: () => Promise<void>;
  onDispatched: () => Promise<void>;
}

export interface SessionForkRuntimeContextServiceOptions {
  createAttemptId?: () => string;
  now?: () => number;
}

export const DEFAULT_EXTERNAL_FORK_CONTEXT_POLICY: ExternalForkContextPolicy = Object.freeze({
  privacyMode: 'redact',
  tokenBudget: Object.freeze({
    maxInputTokens: 32_768,
    reservedOutputTokens: 8_192,
  }),
  allowInternalMessages: false,
  allowAttachmentProvenance: true,
  allowReadOnlyArtifactProvenance: true,
});

export class SessionForkRuntimeContextService {
  private readonly createAttemptId: () => string;
  private readonly now: () => number;

  constructor(
    private readonly database: SessionForkRuntimeContextDatabase,
    options: SessionForkRuntimeContextServiceOptions = {},
  ) {
    this.createAttemptId = options.createAttemptId ?? (() => `fork_context_${randomUUID()}`);
    this.now = options.now ?? Date.now;
  }

  async prepareFirstChildRun(
    input: PrepareFirstChildRunInput,
  ): Promise<PreparedSessionForkRuntimeContext | null> {
    const source = this.database.getSessionForkContextSource(input.childSessionId);
    if (!source) return null;
    if (source.lineage.contextDeliveryMode !== 'validated_context_handoff') {
      return null;
    }

    const handoff = buildValidatedExternalForkContextHandoff({
      engine: input.engine,
      forkId: source.lineage.forkId,
      sourceSessionId: source.lineage.parentSessionId,
      childSessionId: source.lineage.childSessionId,
      sourceAnchorMessageId: source.lineage.sourceAnchorMessageId,
      anchorChildMessageId: source.lineage.anchorChildMessageId,
      sourcePrefixDigest: source.sourcePrefixDigest,
      mappedActivePrefix: source.mappedActivePrefix,
      firstUserPrompt: input.firstUserPrompt,
      policy: input.policy,
      createdAt: this.now(),
    });
    const existing = this.readContextHandoff(source.lineage.forkId);
    if (
      existing
      && (
        existing.engine !== input.engine
        || existing.payloadDigest !== handoff.payloadDigest
      )
    ) {
      throw new ExternalForkContextError(
        'PAYLOAD_TAMPERED',
        `fork ${source.lineage.forkId} retry does not match its persisted context handoff`,
      );
    }
    if (existing?.state === 'consumed' || existing?.state === 'blocked') {
      throw new ExternalForkContextError(
        'HANDOFF_NOT_CONSUMED',
        `fork ${source.lineage.forkId} context handoff cannot replay from ${existing.state}`,
      );
    }
    const retryAttemptId = existing?.state === 'dispatching'
      ? existing.attemptId
      : null;
    if (existing?.state === 'dispatching' && !retryAttemptId) {
      throw new ExternalForkContextError(
        'HANDOFF_NOT_CONSUMED',
        `fork ${source.lineage.forkId} dispatching handoff has no durable attempt identity`,
      );
    }
    if (!retryAttemptId) {
      this.database.prepareSessionForkContextHandoff(
        source.lineage.forkId,
        input.engine,
        handoff.payloadDigest,
        this.now(),
      );
    }
    const attemptId = retryAttemptId ?? this.createAttemptId();

    return {
      handoff,
      attemptId,
      onDispatchStart: async () => {
        this.database.markSessionForkContextHandoffDispatching(
          source.lineage.forkId,
          handoff.payloadDigest,
          attemptId,
          this.now(),
        );
      },
      onDispatched: async () => {
        this.database.markSessionForkContextHandoffConsumed(
          source.lineage.forkId,
          handoff.payloadDigest,
          attemptId,
          this.now(),
        );
      },
    };
  }

  assertConsumedForResume(
    childSessionId: string,
    engine: ExternalAgentEngineKind,
  ): void {
    const source = this.database.getSessionForkContextSource(childSessionId);
    if (!source || source.lineage.contextDeliveryMode !== 'validated_context_handoff') {
      throw new ExternalForkContextError(
        'HANDOFF_NOT_CONSUMED',
        `fork child ${childSessionId} has no validated context lineage`,
      );
    }
    const record = this.readContextHandoff(source.lineage.forkId);
    if (
      !record
      || record.state !== 'consumed'
      || record.engine !== engine
      || !record.attemptId
      || record.consumedAt === null
    ) {
      const state = record
        ? `${record.state} for ${record.engine}`
        : 'missing';
      throw new ExternalForkContextError(
        'HANDOFF_NOT_CONSUMED',
        `fork child ${childSessionId} cannot resume provider identity because its context handoff is ${state}`,
      );
    }
  }

  private readContextHandoff(forkId: string): SessionForkContextHandoffRecord | null {
    if (this.database.getSessionForkContextHandoff) {
      return this.database.getSessionForkContextHandoff(forkId);
    }
    const raw = this.database.getDb?.()?.prepare(`
      SELECT
        fork_id AS forkId,
        engine,
        payload_digest AS payloadDigest,
        state,
        attempt_id AS attemptId,
        prepared_at AS preparedAt,
        dispatch_started_at AS dispatchStartedAt,
        consumed_at AS consumedAt,
        error_json AS errorJson
      FROM session_fork_context_handoffs
      WHERE fork_id = ?
      LIMIT 1
    `).get(forkId) as Record<string, unknown> | undefined;
    if (!raw) return null;
    return {
      forkId: String(raw.forkId),
      engine: raw.engine as SessionForkContextHandoffRecord['engine'],
      payloadDigest: String(raw.payloadDigest),
      state: raw.state as SessionForkContextHandoffRecord['state'],
      attemptId: typeof raw.attemptId === 'string' ? raw.attemptId : null,
      preparedAt: Number(raw.preparedAt),
      dispatchStartedAt: raw.dispatchStartedAt === null ? null : Number(raw.dispatchStartedAt),
      consumedAt: raw.consumedAt === null ? null : Number(raw.consumedAt),
      error: null,
    };
  }
}
