import { createHash } from 'node:crypto';

import type {
  ExternalAgentEngineKind,
} from '../../../../shared/contract/agentEngine';
import type {
  Artifact,
  Message,
  MessageAttachment,
  MessageRole,
} from '../../../../shared/contract/message';
import { redactCredentialText } from '../../../../shared/security/secretPatterns';
import { estimateTokens } from '../../../context/tokenEstimator';

export type ExternalForkContextSupportedEngine = 'codex_cli' | 'claude_code';
export type ExternalForkContextDeliveryMode = 'validated_context_handoff' | 'unsupported';
export type ExternalForkContextPrivacyMode = 'redact' | 'reject';

export type ExternalForkContextErrorCode =
  | 'UNSUPPORTED_ENGINE'
  | 'INVALID_PREFIX'
  | 'INVALID_POLICY'
  | 'TOKEN_BUDGET_EXCEEDED'
  | 'PRIVACY_REJECTED'
  | 'PROVENANCE_REJECTED'
  | 'IDENTITY_REUSE_FORBIDDEN'
  | 'DISPATCH_LIFECYCLE_REQUIRED'
  | 'PROMPT_MISMATCH'
  | 'PAYLOAD_TAMPERED';

export class ExternalForkContextError extends Error {
  constructor(
    readonly code: ExternalForkContextErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'ExternalForkContextError';
  }
}

export interface ExternalForkContextEngineCapability {
  readonly deliveryMode: ExternalForkContextDeliveryMode;
  readonly providerNativeFork: false;
  readonly firstRunTransport?: 'stdin_text';
  readonly reason: string;
}

/**
 * No external adapter currently exposes a provider-native "fork this session"
 * primitive. Codex and Claude therefore receive a new-session context handoff.
 * MiMo and Kimi stay fail-closed until their launch inputs have equivalent
 * privacy, provenance, and budget verification.
 */
export const EXTERNAL_FORK_CONTEXT_CAPABILITIES: Readonly<
  Record<ExternalAgentEngineKind, ExternalForkContextEngineCapability>
> = Object.freeze({
  codex_cli: Object.freeze({
    deliveryMode: 'validated_context_handoff',
    providerNativeFork: false,
    firstRunTransport: 'stdin_text',
    reason: 'Codex CLI accepts a bounded transcript on stdin for a new external session.',
  }),
  claude_code: Object.freeze({
    deliveryMode: 'validated_context_handoff',
    providerNativeFork: false,
    firstRunTransport: 'stdin_text',
    reason: 'Claude Code print mode accepts a bounded transcript on stdin for a new external session.',
  }),
  mimo_code: Object.freeze({
    deliveryMode: 'unsupported',
    providerNativeFork: false,
    reason: 'MiMo fork-context launch wiring has not been verified.',
  }),
  kimi_code: Object.freeze({
    deliveryMode: 'unsupported',
    providerNativeFork: false,
    reason: 'Kimi fork-context launch wiring has not been verified.',
  }),
});

export interface ExternalForkContextTokenPolicy {
  /** Provider input limit for the complete context handoff plus first prompt. */
  readonly maxInputTokens: number;
  /** Output/tool headroom that may not be consumed by the handoff. */
  readonly reservedOutputTokens: number;
}

export interface ExternalForkContextPolicy {
  readonly privacyMode: ExternalForkContextPrivacyMode;
  readonly tokenBudget: ExternalForkContextTokenPolicy;
  /**
   * System, tool, and meta messages are never silently omitted. The caller must
   * explicitly allow them or the builder rejects the prefix.
   */
  readonly allowInternalMessages: boolean;
  /**
   * Attachments are represented by metadata and a digest only. Bytes, extracted
   * content, thumbnails, local paths, and nested file lists are never emitted.
   */
  readonly allowAttachmentProvenance: boolean;
  /**
   * Artifacts are represented by metadata and a content digest only. Their
   * mutable content is never emitted.
   */
  readonly allowReadOnlyArtifactProvenance: boolean;
}

export interface MappedActiveForkMessage {
  readonly ordinal: number;
  readonly sourceMessageId: string;
  readonly childMessageId: string;
  readonly message: Pick<
    Message,
    | 'role'
    | 'content'
    | 'timestamp'
    | 'visibility'
    | 'isMeta'
    | 'attachments'
    | 'artifacts'
  >;
}

export interface BuildExternalForkContextHandoffInput {
  readonly engine: ExternalAgentEngineKind;
  readonly forkId: string;
  readonly sourceSessionId: string;
  readonly childSessionId: string;
  readonly sourceAnchorMessageId: string;
  readonly anchorChildMessageId: string;
  readonly sourcePrefixDigest: string;
  readonly mappedActivePrefix: readonly MappedActiveForkMessage[];
  readonly firstUserPrompt: string;
  readonly policy: ExternalForkContextPolicy;
  readonly createdAt?: number;
}

export interface ExternalForkContextMessage {
  readonly ordinal: number;
  readonly sourceMessageId: string;
  readonly childMessageId: string;
  readonly role: MessageRole;
  readonly content: string;
  readonly timestamp: number;
  readonly isMeta: boolean;
}

export interface ExternalForkAttachmentProvenance {
  readonly sourceMessageId: string;
  readonly attachmentId: string;
  readonly name: string;
  readonly category: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly mediaState?: string;
  readonly digest: string;
  readonly access: 'read_only';
  readonly contentIncluded: false;
}

export interface ExternalForkArtifactProvenance {
  readonly sourceMessageId: string;
  readonly artifactId: string;
  readonly kind: string;
  readonly title?: string;
  readonly version: number;
  readonly digest: string;
  readonly access: 'read_only';
  readonly contentIncluded: false;
}

export interface ExternalForkContextBudgetVerdict {
  readonly maxInputTokens: number;
  readonly reservedOutputTokens: number;
  readonly availableInputTokens: number;
  readonly contextTokens: number;
  readonly firstPromptTokens: number;
  /**
   * Conservative charge. It includes fixed serialization/instruction headroom;
   * the adapter recomputes the actual launch prompt and rejects any overrun.
   */
  readonly chargedInputTokens: number;
  readonly verdict: 'passed';
}

export interface ExternalForkContextPrivacyVerdict {
  readonly mode: ExternalForkContextPrivacyMode;
  readonly verdict: 'passed' | 'passed_with_redactions';
  readonly redactedFieldCount: number;
}

export interface ExternalForkContextHandoff {
  readonly version: 1;
  readonly scope: 'first_child_run';
  readonly deliveryMode: 'validated_context_handoff';
  readonly engine: ExternalForkContextSupportedEngine;
  readonly providerNativeFork: false;
  readonly sourceRuntimeIdentityCopied: false;
  readonly forkId: string;
  readonly sourceSessionId: string;
  readonly childSessionId: string;
  readonly sourceAnchorMessageId: string;
  readonly anchorChildMessageId: string;
  readonly sourcePrefixDigest: string;
  readonly contextPrefixDigest: string;
  readonly firstUserPromptDigest: string;
  readonly sanitizedFirstUserPrompt: string;
  readonly messages: readonly ExternalForkContextMessage[];
  readonly attachments: readonly ExternalForkAttachmentProvenance[];
  readonly artifacts: readonly ExternalForkArtifactProvenance[];
  readonly budget: ExternalForkContextBudgetVerdict;
  readonly privacy: ExternalForkContextPrivacyVerdict;
  readonly createdAt: number;
  readonly payloadDigest: string;
}

export interface ComposeExternalForkLaunchPromptInput {
  readonly engine: ExternalAgentEngineKind;
  readonly handoff: ExternalForkContextHandoff;
  /** Original, unmodified prompt supplied by the user for the child run. */
  readonly prompt: string;
  /** A fork child must always start a fresh provider runtime. */
  readonly resumeLaunchPresent?: boolean;
}

export interface ExternalForkContextAuditSummary {
  readonly forkId: string;
  readonly deliveryMode: 'validated_context_handoff';
  readonly payloadDigest: string;
  readonly sourcePrefixDigest: string;
  readonly contextPrefixDigest: string;
  readonly messageCount: number;
  readonly attachmentCount: number;
  readonly artifactCount: number;
  readonly chargedInputTokens: number;
  readonly privacyVerdict: ExternalForkContextPrivacyVerdict['verdict'];
  readonly redactedFieldCount: number;
  readonly providerNativeFork: false;
}

export type ExternalForkContextDispatchCallback = (
  audit: ExternalForkContextAuditSummary,
) => void | Promise<void>;

const SHA256_RE = /^[a-f0-9]{64}$/;
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SERIALIZATION_OVERHEAD_TOKENS = 256;
const FORBIDDEN_IDENTITY_KEYS = new Set([
  'externalsessionid',
  'providersessionid',
  'runtimeidentity',
  'resumeidentity',
  'resumelaunch',
  'runid',
  'sessiontoken',
]);

const HANDOFF_TOP_LEVEL_KEYS = new Set([
  'version',
  'scope',
  'deliveryMode',
  'engine',
  'providerNativeFork',
  'sourceRuntimeIdentityCopied',
  'forkId',
  'sourceSessionId',
  'childSessionId',
  'sourceAnchorMessageId',
  'anchorChildMessageId',
  'sourcePrefixDigest',
  'contextPrefixDigest',
  'firstUserPromptDigest',
  'sanitizedFirstUserPrompt',
  'messages',
  'attachments',
  'artifacts',
  'budget',
  'privacy',
  'createdAt',
  'payloadDigest',
]);

const HANDOFF_MESSAGE_KEYS = new Set([
  'ordinal',
  'sourceMessageId',
  'childMessageId',
  'role',
  'content',
  'timestamp',
  'isMeta',
]);

const HANDOFF_ATTACHMENT_KEYS = new Set([
  'sourceMessageId',
  'attachmentId',
  'name',
  'category',
  'mimeType',
  'sizeBytes',
  'mediaState',
  'digest',
  'access',
  'contentIncluded',
]);

const HANDOFF_ARTIFACT_KEYS = new Set([
  'sourceMessageId',
  'artifactId',
  'kind',
  'title',
  'version',
  'digest',
  'access',
  'contentIncluded',
]);

const HANDOFF_BUDGET_KEYS = new Set([
  'maxInputTokens',
  'reservedOutputTokens',
  'availableInputTokens',
  'contextTokens',
  'firstPromptTokens',
  'chargedInputTokens',
  'verdict',
]);

const HANDOFF_PRIVACY_KEYS = new Set([
  'mode',
  'verdict',
  'redactedFieldCount',
]);

const MESSAGE_ROLES = new Set<MessageRole>(['user', 'assistant', 'system', 'tool']);

interface PrivacyAccumulator {
  redactedFieldCount: number;
}

export function getExternalForkContextCapability(
  engine: ExternalAgentEngineKind,
): ExternalForkContextEngineCapability {
  return EXTERNAL_FORK_CONTEXT_CAPABILITIES[engine];
}

export function buildValidatedExternalForkContextHandoff(
  input: BuildExternalForkContextHandoffInput,
): ExternalForkContextHandoff {
  const capability = getExternalForkContextCapability(input.engine);
  if (capability.deliveryMode !== 'validated_context_handoff') {
    throw new ExternalForkContextError(
      'UNSUPPORTED_ENGINE',
      `${input.engine} cannot receive fork context: ${capability.reason}`,
    );
  }
  const engine = input.engine as ExternalForkContextSupportedEngine;
  assertPolicy(input.policy);
  assertIdentifier('forkId', input.forkId);
  assertIdentifier('sourceSessionId', input.sourceSessionId);
  assertIdentifier('childSessionId', input.childSessionId);
  assertIdentifier('sourceAnchorMessageId', input.sourceAnchorMessageId);
  assertIdentifier('anchorChildMessageId', input.anchorChildMessageId);
  assertDigest('sourcePrefixDigest', input.sourcePrefixDigest);
  if (input.sourceSessionId === input.childSessionId) {
    throw new ExternalForkContextError('INVALID_PREFIX', 'source and child session ids must differ');
  }
  if (!input.firstUserPrompt.trim()) {
    throw new ExternalForkContextError('INVALID_PREFIX', 'the first child prompt must not be empty');
  }

  const privacy: PrivacyAccumulator = { redactedFieldCount: 0 };
  const messages = buildMessages(input, privacy);
  const lastMessage = messages[messages.length - 1];
  if (
    lastMessage.role !== 'assistant'
    || lastMessage.sourceMessageId !== input.sourceAnchorMessageId
    || lastMessage.childMessageId !== input.anchorChildMessageId
    || !lastMessage.content.trim()
  ) {
    throw new ExternalForkContextError(
      'INVALID_PREFIX',
      'the mapped active prefix must terminate at the requested completed assistant anchor',
    );
  }

  const attachments = buildAttachmentProvenance(input, privacy);
  const artifacts = buildArtifactProvenance(input, privacy);
  const sanitizedFirstUserPrompt = applyPrivacy(
    input.firstUserPrompt,
    'firstUserPrompt',
    input.policy.privacyMode,
    privacy,
  );
  const contextPrefixDigest = sha256(canonicalJson({
    messages,
    attachments,
    artifacts,
  }));
  const contextDocument = renderContextDocument({
    forkId: input.forkId,
    sourceSessionId: input.sourceSessionId,
    childSessionId: input.childSessionId,
    sourceAnchorMessageId: input.sourceAnchorMessageId,
    anchorChildMessageId: input.anchorChildMessageId,
    sourcePrefixDigest: input.sourcePrefixDigest,
    contextPrefixDigest,
    messages,
    attachments,
    artifacts,
    privacy: {
      mode: input.policy.privacyMode,
      verdict: privacy.redactedFieldCount > 0 ? 'passed_with_redactions' : 'passed',
      redactedFieldCount: privacy.redactedFieldCount,
    },
  });
  const contextTokens = estimateTokens(contextDocument);
  const firstPromptTokens = estimateTokens(sanitizedFirstUserPrompt);
  const availableInputTokens = (
    input.policy.tokenBudget.maxInputTokens
    - input.policy.tokenBudget.reservedOutputTokens
  );
  const chargedInputTokens = contextTokens + firstPromptTokens + SERIALIZATION_OVERHEAD_TOKENS;
  if (chargedInputTokens > availableInputTokens) {
    throw new ExternalForkContextError(
      'TOKEN_BUDGET_EXCEEDED',
      `fork context requires ${chargedInputTokens} input tokens but only ${availableInputTokens} are available`,
    );
  }

  const draft: Omit<ExternalForkContextHandoff, 'payloadDigest'> = {
    version: 1,
    scope: 'first_child_run',
    deliveryMode: 'validated_context_handoff',
    engine,
    providerNativeFork: false,
    sourceRuntimeIdentityCopied: false,
    forkId: input.forkId,
    sourceSessionId: input.sourceSessionId,
    childSessionId: input.childSessionId,
    sourceAnchorMessageId: input.sourceAnchorMessageId,
    anchorChildMessageId: input.anchorChildMessageId,
    sourcePrefixDigest: input.sourcePrefixDigest,
    contextPrefixDigest,
    firstUserPromptDigest: sha256(input.firstUserPrompt),
    sanitizedFirstUserPrompt,
    messages,
    attachments,
    artifacts,
    budget: {
      maxInputTokens: input.policy.tokenBudget.maxInputTokens,
      reservedOutputTokens: input.policy.tokenBudget.reservedOutputTokens,
      availableInputTokens,
      contextTokens,
      firstPromptTokens,
      chargedInputTokens,
      verdict: 'passed',
    },
    privacy: {
      mode: input.policy.privacyMode,
      verdict: privacy.redactedFieldCount > 0 ? 'passed_with_redactions' : 'passed',
      redactedFieldCount: privacy.redactedFieldCount,
    },
    createdAt: input.createdAt ?? Date.now(),
  };
  const payload: ExternalForkContextHandoff = {
    ...draft,
    payloadDigest: sha256(canonicalJson(draft)),
  };
  return deepFreeze(payload);
}

export function composeExternalForkLaunchPrompt(
  input: ComposeExternalForkLaunchPromptInput,
): string {
  if (input.resumeLaunchPresent) {
    throw new ExternalForkContextError(
      'IDENTITY_REUSE_FORBIDDEN',
      'a fork child cannot resume or copy the source provider runtime identity',
    );
  }
  assertExternalForkContextHandoff(input.handoff);
  if (input.engine !== input.handoff.engine) {
    throw new ExternalForkContextError(
      'PAYLOAD_TAMPERED',
      `handoff engine ${input.handoff.engine} does not match launch engine ${input.engine}`,
    );
  }
  if (sha256(input.prompt) !== input.handoff.firstUserPromptDigest) {
    throw new ExternalForkContextError(
      'PROMPT_MISMATCH',
      'the first child prompt no longer matches the validated handoff',
    );
  }

  const launchPrompt = [
    renderContextDocument(input.handoff),
    '<<<NEO_CURRENT_USER_REQUEST_V1>>>',
    input.handoff.sanitizedFirstUserPrompt,
    '<<<END_NEO_CURRENT_USER_REQUEST_V1>>>',
  ].join('\n');
  const actualInputTokens = estimateTokens(launchPrompt);
  if (
    actualInputTokens > input.handoff.budget.availableInputTokens
    || actualInputTokens > input.handoff.budget.chargedInputTokens
  ) {
    throw new ExternalForkContextError(
      'TOKEN_BUDGET_EXCEEDED',
      `serialized launch requires ${actualInputTokens} tokens, exceeding the validated budget`,
    );
  }
  return launchPrompt;
}

export function assertExternalForkContextHandoff(
  handoff: ExternalForkContextHandoff,
): void {
  if (!handoff || typeof handoff !== 'object' || Array.isArray(handoff)) {
    throw new ExternalForkContextError('PAYLOAD_TAMPERED', 'fork context handoff must be an object');
  }
  assertNoForbiddenIdentityKeys(handoff);
  assertAllowedKeys(handoff, HANDOFF_TOP_LEVEL_KEYS, 'handoff');
  if (
    handoff.version !== 1
    || handoff.scope !== 'first_child_run'
    || handoff.deliveryMode !== 'validated_context_handoff'
    || handoff.providerNativeFork !== false
    || handoff.sourceRuntimeIdentityCopied !== false
  ) {
    throw new ExternalForkContextError('PAYLOAD_TAMPERED', 'fork context protocol invariants are invalid');
  }
  const capability = getExternalForkContextCapability(handoff.engine);
  if (capability.deliveryMode !== 'validated_context_handoff') {
    throw new ExternalForkContextError('UNSUPPORTED_ENGINE', `${handoff.engine} fork context is unsupported`);
  }
  assertIdentifier('forkId', handoff.forkId);
  assertIdentifier('sourceSessionId', handoff.sourceSessionId);
  assertIdentifier('childSessionId', handoff.childSessionId);
  assertIdentifier('sourceAnchorMessageId', handoff.sourceAnchorMessageId);
  assertIdentifier('anchorChildMessageId', handoff.anchorChildMessageId);
  assertDigest('sourcePrefixDigest', handoff.sourcePrefixDigest);
  assertDigest('contextPrefixDigest', handoff.contextPrefixDigest);
  assertDigest('firstUserPromptDigest', handoff.firstUserPromptDigest);
  assertDigest('payloadDigest', handoff.payloadDigest);
  assertSafeDeliveredText(handoff.sanitizedFirstUserPrompt, 'sanitizedFirstUserPrompt');
  if (!Array.isArray(handoff.messages) || handoff.messages.length === 0) {
    throw new ExternalForkContextError('PAYLOAD_TAMPERED', 'fork context messages are missing');
  }
  const messages: readonly ExternalForkContextMessage[] = handoff.messages;
  const sourceMessageIds = new Set<string>();
  const childMessageIds = new Set<string>();
  messages.forEach((message, ordinal) => {
    assertAllowedKeys(message, HANDOFF_MESSAGE_KEYS, `messages[${ordinal}]`);
    if (
      message.ordinal !== ordinal
      || !Number.isFinite(message.timestamp)
      || typeof message.content !== 'string'
      || typeof message.isMeta !== 'boolean'
      || !MESSAGE_ROLES.has(message.role)
    ) {
      throw new ExternalForkContextError('PAYLOAD_TAMPERED', `messages[${ordinal}] is invalid`);
    }
    assertIdentifier(`messages[${ordinal}].sourceMessageId`, message.sourceMessageId);
    assertIdentifier(`messages[${ordinal}].childMessageId`, message.childMessageId);
    assertSafeDeliveredText(message.content, `messages[${ordinal}].content`);
    if (
      sourceMessageIds.has(message.sourceMessageId)
      || childMessageIds.has(message.childMessageId)
    ) {
      throw new ExternalForkContextError('PAYLOAD_TAMPERED', 'fork context message mappings are not unique');
    }
    sourceMessageIds.add(message.sourceMessageId);
    childMessageIds.add(message.childMessageId);
  });
  const anchor = messages[messages.length - 1];
  if (
    anchor.role !== 'assistant'
    || anchor.sourceMessageId !== handoff.sourceAnchorMessageId
    || anchor.childMessageId !== handoff.anchorChildMessageId
    || !anchor.content.trim()
  ) {
    throw new ExternalForkContextError('PAYLOAD_TAMPERED', 'fork context does not terminate at its assistant anchor');
  }
  if (!Array.isArray(handoff.attachments) || !Array.isArray(handoff.artifacts)) {
    throw new ExternalForkContextError('PAYLOAD_TAMPERED', 'fork context provenance arrays are missing');
  }
  const attachments: readonly ExternalForkAttachmentProvenance[] = handoff.attachments;
  const artifacts: readonly ExternalForkArtifactProvenance[] = handoff.artifacts;
  attachments.forEach((attachment, index) => {
    assertAllowedKeys(attachment, HANDOFF_ATTACHMENT_KEYS, `attachments[${index}]`);
    if (attachment.access !== 'read_only' || attachment.contentIncluded !== false) {
      throw new ExternalForkContextError('PROVENANCE_REJECTED', 'attachment provenance must be read-only metadata');
    }
    assertIdentifier(`attachments[${index}].sourceMessageId`, attachment.sourceMessageId);
    assertIdentifier(`attachments[${index}].attachmentId`, attachment.attachmentId);
    assertDigest(`attachments[${index}].digest`, attachment.digest);
    assertSafeDeliveredText(attachment.name, `attachments[${index}].name`);
    assertSafeDeliveredText(attachment.category, `attachments[${index}].category`);
    assertSafeDeliveredText(attachment.mimeType, `attachments[${index}].mimeType`);
    if (!Number.isFinite(attachment.sizeBytes) || attachment.sizeBytes < 0) {
      throw new ExternalForkContextError('PROVENANCE_REJECTED', 'attachment size must be non-negative');
    }
  });
  artifacts.forEach((artifact, index) => {
    assertAllowedKeys(artifact, HANDOFF_ARTIFACT_KEYS, `artifacts[${index}]`);
    if (artifact.access !== 'read_only' || artifact.contentIncluded !== false) {
      throw new ExternalForkContextError('PROVENANCE_REJECTED', 'artifact provenance must be read-only metadata');
    }
    assertIdentifier(`artifacts[${index}].sourceMessageId`, artifact.sourceMessageId);
    assertIdentifier(`artifacts[${index}].artifactId`, artifact.artifactId);
    assertDigest(`artifacts[${index}].digest`, artifact.digest);
    assertSafeDeliveredText(artifact.kind, `artifacts[${index}].kind`);
    if (artifact.title) assertSafeDeliveredText(artifact.title, `artifacts[${index}].title`);
    if (!Number.isInteger(artifact.version) || artifact.version < 0) {
      throw new ExternalForkContextError('PROVENANCE_REJECTED', 'artifact version must be non-negative');
    }
  });
  if (
    !handoff.budget
    || typeof handoff.budget !== 'object'
    || !handoff.privacy
    || typeof handoff.privacy !== 'object'
  ) {
    throw new ExternalForkContextError('PAYLOAD_TAMPERED', 'fork context verdicts are missing');
  }
  assertAllowedKeys(handoff.budget, HANDOFF_BUDGET_KEYS, 'budget');
  assertAllowedKeys(handoff.privacy, HANDOFF_PRIVACY_KEYS, 'privacy');
  if (
    handoff.budget.verdict !== 'passed'
    || handoff.budget.chargedInputTokens > handoff.budget.availableInputTokens
    || handoff.budget.availableInputTokens !== (
      handoff.budget.maxInputTokens - handoff.budget.reservedOutputTokens
    )
    || handoff.budget.contextTokens < 0
    || handoff.budget.firstPromptTokens < 0
    || handoff.budget.chargedInputTokens !== (
      handoff.budget.contextTokens
      + handoff.budget.firstPromptTokens
      + SERIALIZATION_OVERHEAD_TOKENS
    )
  ) {
    throw new ExternalForkContextError('TOKEN_BUDGET_EXCEEDED', 'fork context budget verdict is invalid');
  }
  if (
    (handoff.privacy.mode !== 'redact' && handoff.privacy.mode !== 'reject')
    || !Number.isInteger(handoff.privacy.redactedFieldCount)
    || handoff.privacy.redactedFieldCount < 0
    || (
      handoff.privacy.redactedFieldCount === 0
        ? handoff.privacy.verdict !== 'passed'
        : handoff.privacy.verdict !== 'passed_with_redactions'
    )
  ) {
    throw new ExternalForkContextError('PRIVACY_REJECTED', 'fork context privacy verdict is invalid');
  }
  const expectedContextDigest = sha256(canonicalJson({
    messages: handoff.messages,
    attachments: handoff.attachments,
    artifacts: handoff.artifacts,
  }));
  if (expectedContextDigest !== handoff.contextPrefixDigest) {
    throw new ExternalForkContextError('PAYLOAD_TAMPERED', 'fork context prefix digest does not match its payload');
  }
  const actualContextTokens = estimateTokens(renderContextDocument(handoff));
  const actualFirstPromptTokens = estimateTokens(handoff.sanitizedFirstUserPrompt);
  if (
    actualContextTokens !== handoff.budget.contextTokens
    || actualFirstPromptTokens !== handoff.budget.firstPromptTokens
  ) {
    throw new ExternalForkContextError('PAYLOAD_TAMPERED', 'fork context token verdict does not match its payload');
  }
  const { payloadDigest: _payloadDigest, ...unsignedPayload } = handoff;
  if (sha256(canonicalJson(unsignedPayload)) !== handoff.payloadDigest) {
    throw new ExternalForkContextError('PAYLOAD_TAMPERED', 'fork context payload digest does not match');
  }
}

export function summarizeExternalForkContextHandoff(
  handoff: ExternalForkContextHandoff,
): ExternalForkContextAuditSummary {
  assertExternalForkContextHandoff(handoff);
  return deepFreeze({
    forkId: handoff.forkId,
    deliveryMode: handoff.deliveryMode,
    payloadDigest: handoff.payloadDigest,
    sourcePrefixDigest: handoff.sourcePrefixDigest,
    contextPrefixDigest: handoff.contextPrefixDigest,
    messageCount: handoff.messages.length,
    attachmentCount: handoff.attachments.length,
    artifactCount: handoff.artifacts.length,
    chargedInputTokens: handoff.budget.chargedInputTokens,
    privacyVerdict: handoff.privacy.verdict,
    redactedFieldCount: handoff.privacy.redactedFieldCount,
    providerNativeFork: false,
  });
}

export function assertExternalForkContextDispatchLifecycle(
  handoff: ExternalForkContextHandoff | undefined,
  onDispatchStart: ExternalForkContextDispatchCallback | undefined,
  onDispatched: ExternalForkContextDispatchCallback | undefined,
): void {
  if (!handoff) return;
  if (!onDispatchStart || !onDispatched) {
    throw new ExternalForkContextError(
      'DISPATCH_LIFECYCLE_REQUIRED',
      'fork context requires durable dispatch-start and dispatched callbacks',
    );
  }
}

function buildMessages(
  input: BuildExternalForkContextHandoffInput,
  privacy: PrivacyAccumulator,
): ExternalForkContextMessage[] {
  if (input.mappedActivePrefix.length === 0) {
    throw new ExternalForkContextError('INVALID_PREFIX', 'mapped active prefix must not be empty');
  }
  const sourceIds = new Set<string>();
  const childIds = new Set<string>();
  return input.mappedActivePrefix.map((entry, index) => {
    if (entry.ordinal !== index) {
      throw new ExternalForkContextError('INVALID_PREFIX', 'mapped prefix ordinals must be contiguous and start at zero');
    }
    assertIdentifier(`mappedActivePrefix[${index}].sourceMessageId`, entry.sourceMessageId);
    assertIdentifier(`mappedActivePrefix[${index}].childMessageId`, entry.childMessageId);
    if (sourceIds.has(entry.sourceMessageId) || childIds.has(entry.childMessageId)) {
      throw new ExternalForkContextError('INVALID_PREFIX', 'mapped prefix message ids must be unique');
    }
    sourceIds.add(entry.sourceMessageId);
    childIds.add(entry.childMessageId);
    if (entry.message.visibility !== 'active') {
      throw new ExternalForkContextError('INVALID_PREFIX', `message ${entry.sourceMessageId} is not active`);
    }
    if (!Number.isFinite(entry.message.timestamp) || typeof entry.message.content !== 'string') {
      throw new ExternalForkContextError('INVALID_PREFIX', `message ${entry.sourceMessageId} is malformed`);
    }
    const internal = Boolean(entry.message.isMeta)
      || entry.message.role === 'system'
      || entry.message.role === 'tool';
    if (internal && !input.policy.allowInternalMessages) {
      throw new ExternalForkContextError(
        'PRIVACY_REJECTED',
        `message ${entry.sourceMessageId} requires allowInternalMessages`,
      );
    }
    return {
      ordinal: entry.ordinal,
      sourceMessageId: entry.sourceMessageId,
      childMessageId: entry.childMessageId,
      role: entry.message.role,
      content: applyPrivacy(
        entry.message.content,
        `message ${entry.sourceMessageId}`,
        input.policy.privacyMode,
        privacy,
      ),
      timestamp: entry.message.timestamp,
      isMeta: Boolean(entry.message.isMeta),
    };
  });
}

function buildAttachmentProvenance(
  input: BuildExternalForkContextHandoffInput,
  privacy: PrivacyAccumulator,
): ExternalForkAttachmentProvenance[] {
  const attachments = input.mappedActivePrefix.flatMap((entry) => entry.message.attachments ?? []);
  if (attachments.length > 0 && !input.policy.allowAttachmentProvenance) {
    throw new ExternalForkContextError(
      'PROVENANCE_REJECTED',
      'the mapped prefix contains attachments but attachment provenance is not allowed',
    );
  }
  return input.mappedActivePrefix.flatMap((entry) =>
    (entry.message.attachments ?? []).map((attachment) =>
      attachmentToProvenance(
        entry.sourceMessageId,
        attachment,
        input.policy.privacyMode,
        privacy,
      )));
}

function buildArtifactProvenance(
  input: BuildExternalForkContextHandoffInput,
  privacy: PrivacyAccumulator,
): ExternalForkArtifactProvenance[] {
  const artifacts = input.mappedActivePrefix.flatMap((entry) => entry.message.artifacts ?? []);
  if (artifacts.length > 0 && !input.policy.allowReadOnlyArtifactProvenance) {
    throw new ExternalForkContextError(
      'PROVENANCE_REJECTED',
      'the mapped prefix contains artifacts but read-only artifact provenance is not allowed',
    );
  }
  return input.mappedActivePrefix.flatMap((entry) =>
    (entry.message.artifacts ?? []).map((artifact) =>
      artifactToProvenance(
        entry.sourceMessageId,
        artifact,
        input.policy.privacyMode,
        privacy,
      )));
}

function attachmentToProvenance(
  sourceMessageId: string,
  attachment: MessageAttachment,
  privacyMode: ExternalForkContextPrivacyMode,
  privacy: PrivacyAccumulator,
): ExternalForkAttachmentProvenance {
  assertIdentifier('attachment.id', attachment.id);
  if (!Number.isFinite(attachment.size) || attachment.size < 0) {
    throw new ExternalForkContextError('PROVENANCE_REJECTED', `attachment ${attachment.id} has an invalid size`);
  }
  return {
    sourceMessageId,
    attachmentId: attachment.id,
    name: applyPrivacy(attachment.name, `attachment ${attachment.id} name`, privacyMode, privacy),
    category: applyPrivacy(String(attachment.category), `attachment ${attachment.id} category`, privacyMode, privacy),
    mimeType: applyPrivacy(attachment.mimeType, `attachment ${attachment.id} mimeType`, privacyMode, privacy),
    sizeBytes: attachment.size,
    ...(attachment.mediaState
      ? { mediaState: applyPrivacy(attachment.mediaState, `attachment ${attachment.id} mediaState`, privacyMode, privacy) }
      : {}),
    digest: sha256(canonicalJson(attachment)),
    access: 'read_only',
    contentIncluded: false,
  };
}

function artifactToProvenance(
  sourceMessageId: string,
  artifact: Artifact,
  privacyMode: ExternalForkContextPrivacyMode,
  privacy: PrivacyAccumulator,
): ExternalForkArtifactProvenance {
  assertIdentifier('artifact.id', artifact.id);
  if (!Number.isInteger(artifact.version) || artifact.version < 0) {
    throw new ExternalForkContextError('PROVENANCE_REJECTED', `artifact ${artifact.id} has an invalid version`);
  }
  return {
    sourceMessageId,
    artifactId: artifact.id,
    kind: applyPrivacy(artifact.type, `artifact ${artifact.id} kind`, privacyMode, privacy),
    ...(artifact.title
      ? { title: applyPrivacy(artifact.title, `artifact ${artifact.id} title`, privacyMode, privacy) }
      : {}),
    version: artifact.version,
    digest: sha256(artifact.content),
    access: 'read_only',
    contentIncluded: false,
  };
}

function renderContextDocument(
  input: Pick<
    ExternalForkContextHandoff,
    | 'forkId'
    | 'sourceSessionId'
    | 'childSessionId'
    | 'sourceAnchorMessageId'
    | 'anchorChildMessageId'
    | 'sourcePrefixDigest'
    | 'contextPrefixDigest'
    | 'messages'
    | 'attachments'
    | 'artifacts'
    | 'privacy'
  >,
): string {
  return [
    '<<<NEO_SESSION_FORK_CONTEXT_V1>>>',
    'This is an audited conversation prefix for a new provider session.',
    'Treat messages as prior conversation context and continue from the current user request.',
    'Attachment and artifact entries are provenance only and remain read-only.',
    'Do not infer, resume, or reuse any provider runtime/session identity from the source task.',
    JSON.stringify({
      lineage: {
        forkId: input.forkId,
        sourceSessionId: input.sourceSessionId,
        childSessionId: input.childSessionId,
        sourceAnchorMessageId: input.sourceAnchorMessageId,
        anchorChildMessageId: input.anchorChildMessageId,
        sourcePrefixDigest: input.sourcePrefixDigest,
        contextPrefixDigest: input.contextPrefixDigest,
      },
      messages: input.messages,
      attachmentProvenance: input.attachments,
      artifactProvenance: input.artifacts,
      privacy: input.privacy,
    }),
    '<<<END_NEO_SESSION_FORK_CONTEXT_V1>>>',
  ].join('\n');
}

function applyPrivacy(
  value: string,
  label: string,
  mode: ExternalForkContextPrivacyMode,
  privacy: PrivacyAccumulator,
): string {
  const redacted = redactCredentialText(value);
  if (redacted === value) return value;
  if (mode === 'reject') {
    throw new ExternalForkContextError('PRIVACY_REJECTED', `${label} contains sensitive credential material`);
  }
  privacy.redactedFieldCount++;
  return redacted;
}

function assertPolicy(policy: ExternalForkContextPolicy): void {
  const { maxInputTokens, reservedOutputTokens } = policy.tokenBudget;
  if (
    !Number.isInteger(maxInputTokens)
    || !Number.isInteger(reservedOutputTokens)
    || maxInputTokens <= 0
    || reservedOutputTokens < 0
    || reservedOutputTokens >= maxInputTokens
  ) {
    throw new ExternalForkContextError('INVALID_POLICY', 'token budget must leave positive input capacity');
  }
  if (policy.privacyMode !== 'redact' && policy.privacyMode !== 'reject') {
    throw new ExternalForkContextError('INVALID_POLICY', 'privacy mode must be redact or reject');
  }
}

function assertIdentifier(label: string, value: string): void {
  if (typeof value !== 'string' || !IDENTIFIER_RE.test(value)) {
    throw new ExternalForkContextError('INVALID_PREFIX', `${label} is missing or malformed`);
  }
  if (redactCredentialText(value) !== value) {
    throw new ExternalForkContextError('PRIVACY_REJECTED', `${label} resembles sensitive credential material`);
  }
}

function assertDigest(label: string, value: string): void {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    throw new ExternalForkContextError('PAYLOAD_TAMPERED', `${label} must be a lowercase SHA-256 digest`);
  }
}

function assertSafeDeliveredText(value: string, label: string): void {
  if (typeof value !== 'string' || redactCredentialText(value) !== value) {
    throw new ExternalForkContextError(
      'PRIVACY_REJECTED',
      `${label} contains unredacted credential material`,
    );
  }
}

function assertNoForbiddenIdentityKeys(value: unknown, path = 'handoff'): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoForbiddenIdentityKeys(entry, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_IDENTITY_KEYS.has(key.toLowerCase())) {
      throw new ExternalForkContextError(
        'IDENTITY_REUSE_FORBIDDEN',
        `${path}.${key} must not be present in a fork context handoff`,
      );
    }
    assertNoForbiddenIdentityKeys(child, `${path}.${key}`);
  }
}

function assertAllowedKeys(
  value: object,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ExternalForkContextError('PAYLOAD_TAMPERED', `${path}.${key} is not part of the handoff schema`);
    }
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}
