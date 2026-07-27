import { randomUUID } from 'node:crypto';

import type { ExternalAgentEngineKind } from '../../../../shared/contract/agentEngine';
import type {
  SessionForkContextHandoffRecord,
  SessionForkContextSource,
} from '../../core/repositories/SessionForkRepository';
import {
  buildValidatedExternalForkContextHandoff,
  type ExternalForkContextHandoff,
  type ExternalForkContextPolicy,
} from './externalForkContextHandoff';

export interface SessionForkRuntimeContextDatabase {
  getSessionForkContextSource(childSessionId: string): SessionForkContextSource | null;
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
    this.database.prepareSessionForkContextHandoff(
      source.lineage.forkId,
      input.engine,
      handoff.payloadDigest,
      this.now(),
    );
    const attemptId = this.createAttemptId();

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
}
