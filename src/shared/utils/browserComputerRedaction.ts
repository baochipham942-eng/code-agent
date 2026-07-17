import { makeEvidenceRef, type EvidenceKind, type EvidenceRef, type EvidenceState, type RedactionStatus } from "../contract/evidence";
import type { AgentPointerEvent } from "../contract/desktop";

export { sanitizeLargeTextToolArguments } from './browserComputerLargeTextRedaction';

const BROWSER_COMPUTER_TOOLS = new Set(["browser_action", "computer_use"]);
const INPUT_PAYLOAD_ACTIONS = new Set(["type", "smart_type", "fill_form"]);
const SECRET_REF_PLACEHOLDER = "[secretRef]";
const SENSITIVE_KEY_PATTERN =
  /password|token|secret|credential|cookie|authorization/i;
const SENSITIVE_PATH_KEY_PATTERN =
  /profile(dir|path)|userDataDir|artifact(dir|path)|download(dir|path)|uploadFilePath|workspace(scope|path|root|dir|directory)|storageState|localStorage|sessionStorage/i;
const RAW_BROWSER_COMPUTER_METADATA_KEYS = new Set([
  "accessibilitySnapshot",
  "analysis",
  "axTree",
  "base64",
  "data",
  "domSnapshot",
  "elements",
  "html",
  "imageBase64",
  "authToken",
  "cookie",
  "cookies",
  "encrypted_value",
  "encryptedValue",
  "keychainPassword",
  "keyMaterial",
  "localStorage",
  "profileDir",
  "profilePath",
  "rawAccessibilitySnapshot",
  "rawAxTree",
  "rawDomSnapshot",
  "rawHtml",
  "screenshotBase64",
  "screenshotData",
  "sessionStorage",
  "storageState",
  "userDataDir",
]);
const OMIT = Symbol("omit-browser-computer-metadata");

export type BrowserComputerManualTakeoverStatus =
  | "login_required"
  | "mfa_required"
  | "captcha_or_risk_control"
  | "manual_takeover_required";

export interface BrowserComputerManualTakeover {
  status: BrowserComputerManualTakeoverStatus;
  reason: string;
  recommendedAction: string;
  resumeRequires: string[];
}

export interface BrowserComputerVisualObservation {
  observed: boolean;
  source: "analysis" | "dom" | "a11y" | "ax" | "trace" | "none";
  reason?: string;
  cannotObserveScreen?: boolean;
}

export interface BrowserComputerProof {
  evidenceRefs: EvidenceRef[];
  targetRef?: Record<string, unknown> | null;
  approval?: Record<string, unknown> | null;
  manualTakeover?: BrowserComputerManualTakeover | null;
  visualObservation?: BrowserComputerVisualObservation;
  agentPointerEvent?: AgentPointerEvent | null;
}

export interface BrowserComputerEvidenceCard {
  title: string;
  status: "observed" | "not_observed" | "manual_takeover";
  evidenceRefIds: string[];
  summary: string;
  manualTakeover?: BrowserComputerManualTakeover | null;
  visualObservation?: BrowserComputerVisualObservation;
}

export interface BrowserComputerEvidenceInput {
  kind: EvidenceKind;
  ref: string;
  source: string;
  state?: EvidenceState;
  redactionStatus?: RedactionStatus;
}

export interface BuildBrowserComputerProofInput {
  evidence: BrowserComputerEvidenceInput[];
  targetRef?: Record<string, unknown> | null;
  approval?: Record<string, unknown> | null;
  manualTakeoverText?: string | null;
  manualTakeoverResumeRequires?: string[];
  visualObservation?: BrowserComputerVisualObservation;
  agentPointerEvent?: AgentPointerEvent | null;
  capturedAtMs?: number;
}

export function classifyBrowserComputerManualTakeover(
  text: string | null | undefined,
): BrowserComputerManualTakeoverStatus | null {
  const normalized = (text || "").toLowerCase();
  if (!normalized.trim()) return null;
  if (/captcha|risk control|risk-control|unusual traffic|checking your browser|verify you are human|cloudflare|安全验证|风控|验证码/.test(normalized)) {
    return "captcha_or_risk_control";
  }
  if (/\bmfa\b|two[- ]?factor|2fa|one[- ]time password|\botp\b|verification code|multi[- ]factor|双重验证|二次验证|动态码/.test(normalized)) {
    return "mfa_required";
  }
  if (/login required|sign in required|please sign in|not signed in|unauthorized|authentication required|needs login|登录|请登录/.test(normalized)) {
    return "login_required";
  }
  if (/manual takeover|user takeover|take over manually|requires manual|人工接管|用户接管/.test(normalized)) {
    return "manual_takeover_required";
  }
  return null;
}

function defaultManualTakeoverAction(status: BrowserComputerManualTakeoverStatus): string {
  if (status === "login_required") {
    return "Let the user complete login, then recapture DOM, accessibility, and account state before continuing.";
  }
  if (status === "mfa_required") {
    return "Let the user complete MFA, then recapture DOM, accessibility, and account state before continuing.";
  }
  if (status === "captcha_or_risk_control") {
    return "Stop automation for the challenge, let the user take over, then recapture page evidence before continuing.";
  }
  return "Pause automation for manual takeover, then recapture fresh evidence before continuing.";
}

function buildManualTakeover(
  text: string | null | undefined,
  resumeRequires: string[] | undefined,
): BrowserComputerManualTakeover | null {
  const status = classifyBrowserComputerManualTakeover(text);
  if (!status) return null;
  return {
    status,
    reason: status,
    recommendedAction: defaultManualTakeoverAction(status),
    resumeRequires: resumeRequires && resumeRequires.length > 0
      ? resumeRequires
      : ["recapture_dom", "recapture_a11y", "recapture_account_state"],
  };
}

export function createBrowserComputerEvidenceRef(
  input: BrowserComputerEvidenceInput,
  capturedAtMs: number = Date.now(),
): EvidenceRef {
  return makeEvidenceRef({
    kind: input.kind,
    ref: input.ref,
    source: input.source,
    state: input.state ?? "fresh",
    redactionStatus: input.redactionStatus ?? "clean",
    capturedAtMs,
  });
}

export function buildBrowserComputerProof(input: BuildBrowserComputerProofInput): BrowserComputerProof {
  const capturedAtMs = input.capturedAtMs ?? Date.now();
  return {
    evidenceRefs: input.evidence.map((evidence) => createBrowserComputerEvidenceRef(evidence, capturedAtMs)),
    targetRef: input.targetRef ?? null,
    approval: input.approval ?? null,
    manualTakeover: buildManualTakeover(input.manualTakeoverText, input.manualTakeoverResumeRequires),
    visualObservation: input.visualObservation,
    agentPointerEvent: input.agentPointerEvent ?? null,
  };
}

export function renderBrowserComputerEvidenceCard(proof: BrowserComputerProof): BrowserComputerEvidenceCard {
  const manualTakeover = proof.manualTakeover ?? null;
  const visualObservation = proof.visualObservation;
  const status = manualTakeover
    ? "manual_takeover"
    : visualObservation?.observed
      ? "observed"
      : "not_observed";
  const summary = manualTakeover
    ? `Manual takeover required: ${manualTakeover.status}`
    : visualObservation?.observed
      ? `Observed via ${visualObservation.source}`
      : visualObservation?.reason || "Evidence captured, but UI was not observed.";
  return {
    title: "Browser/Computer Evidence",
    status,
    evidenceRefIds: proof.evidenceRefs.map((ref) => ref.id),
    summary,
    manualTakeover,
    visualObservation,
  };
}

export interface BrowserComputerTraceLike {
  id?: string | null;
  screenshotPath?: string | null;
}

export interface BrowserComputerResultLike {
  output?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

function compactBrowserComputerJson(value: unknown, maxChars = 3000): string {
  try {
    return JSON.stringify(value).slice(0, maxChars);
  } catch {
    return "";
  }
}

function buildBrowserActionEvidenceInputs(
  result: BrowserComputerResultLike,
  trace: BrowserComputerTraceLike,
): BrowserComputerEvidenceInput[] {
  const metadata = result.metadata || {};
  const evidence: BrowserComputerEvidenceInput[] = [];
  const traceId = typeof trace.id === "string" ? trace.id : null;
  if (traceId) {
    evidence.push({
      kind: "trace",
      ref: traceId,
      source: "browserAction.trace",
      state: "fresh",
    });
  }
  if (metadata.domSnapshot && typeof metadata.domSnapshot === "object") {
    const snapshot = metadata.domSnapshot as Record<string, unknown>;
    evidence.push({
      kind: "browser_dom",
      ref: `browser_dom:${String(snapshot.url || "unknown")}#${String(snapshot.snapshotId || traceId || "unknown")}`,
      source: "browserAction.get_dom_snapshot",
      state: "read",
    });
  }
  if (metadata.accessibilitySnapshot) {
    evidence.push({
      kind: "browser_a11y",
      ref: `browser_a11y:${traceId || "unknown"}`,
      source: "browserAction.get_a11y_snapshot",
      state: "read",
    });
  }
  if (typeof metadata.path === "string") {
    evidence.push({
      kind: "screenshot",
      ref: metadata.path,
      source: "browserAction.screenshot",
      state: metadata.analyzed === true ? "read" : "fresh",
    });
  }
  if (metadata.targetRef && typeof metadata.targetRef === "object") {
    const targetRef = metadata.targetRef as Record<string, unknown>;
    evidence.push({
      kind: "browser_dom",
      ref: `targetRef:${String(targetRef.snapshotId || "unknown")}/${String(targetRef.refId || "unknown")}`,
      source: "browserAction.targetRef",
      state: "read",
    });
  }
  if (metadata.browserAccountState && typeof metadata.browserAccountState === "object") {
    const account = metadata.browserAccountState as Record<string, unknown>;
    evidence.push({
      kind: "artifact",
      ref: `browser_account_state:${String(account.status || "unknown")}:${String(account.updatedAtMs || traceId || "unknown")}`,
      source: "browserAction.get_account_state",
      state: "read",
    });
  }
  if (trace.screenshotPath) {
    evidence.push({
      kind: "screenshot",
      ref: trace.screenshotPath,
      source: "browserAction.trace.screenshot",
      state: "fresh",
    });
  }
  return evidence;
}

function inferBrowserActionVisualObservation(result: BrowserComputerResultLike): BrowserComputerVisualObservation {
  const metadata = result.metadata || {};
  if (metadata.domSnapshot) return { observed: true, source: "dom" };
  if (metadata.accessibilitySnapshot) return { observed: true, source: "a11y" };
  if (typeof metadata.path === "string") {
    if (metadata.analyzed === true) return { observed: true, source: "analysis" };
    return {
      observed: false,
      source: "none",
      cannotObserveScreen: true,
      reason: metadata.analysisRequested ? "screenshot_analysis_failed" : "screenshot_path_only",
    };
  }
  return { observed: false, source: "none", reason: "no_dom_a11y_or_analyzed_screenshot" };
}

export function attachBrowserActionProof<T extends BrowserComputerResultLike>(
  result: T,
  trace: BrowserComputerTraceLike,
): T {
  const metadata = result.metadata || {};
  const manualTakeoverText = [
    result.output,
    result.error,
    compactBrowserComputerJson(metadata.domSnapshot),
    compactBrowserComputerJson(metadata.accessibilitySnapshot),
  ].filter(Boolean).join("\n");
  const proof = buildBrowserComputerProof({
    evidence: buildBrowserActionEvidenceInputs(result, trace),
    targetRef: metadata.targetRef && typeof metadata.targetRef === "object"
      ? metadata.targetRef as Record<string, unknown>
      : null,
    approval: metadata.workbenchBlocked
      ? { blocked: true, code: metadata.code || null }
      : null,
    manualTakeoverText,
    manualTakeoverResumeRequires: [
      "browser_action.get_dom_snapshot",
      "browser_action.get_a11y_snapshot",
      "browser_action.get_account_state",
    ],
    visualObservation: inferBrowserActionVisualObservation(result),
    agentPointerEvent: metadata.agentPointerEvent as AgentPointerEvent | null | undefined,
  });
  return {
    ...result,
    metadata: {
      ...metadata,
      evidenceRefs: proof.evidenceRefs,
      browserComputerProof: proof,
      browserComputerEvidenceCard: renderBrowserComputerEvidenceCard(proof),
      ...(proof.visualObservation?.cannotObserveScreen ? { cannotObserveScreen: true } : {}),
    },
  };
}

export type BrowserComputerSecretScopeSummary =
  | {
      kind: "domain";
      domains: string[];
      source: "secretScope" | "domainScope" | "url";
    }
  | {
      kind: "legacy_global";
      explicitlyMarked: true;
      source: "secretScope" | "legacyGlobalSecret";
    }
  | {
      kind: "missing_domain_scope";
      required: true;
    };

export interface BrowserComputerSecretPlaceholderSummary {
  placeholder: typeof SECRET_REF_PLACEHOLDER;
  scope: BrowserComputerSecretScopeSummary;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isBrowserComputerToolName(
  toolName: unknown,
): toolName is "browser_action" | "computer_use" {
  return typeof toolName === "string" && BROWSER_COMPUTER_TOOLS.has(toolName);
}

export function isBrowserComputerInputPayloadAction(action: unknown): boolean {
  return typeof action === "string" && INPUT_PAYLOAD_ACTIONS.has(action);
}

export function redactBrowserComputerTextPreview(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  return text ? `[redacted ${text.length} chars]` : "[redacted text]";
}

function normalizeDomain(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.hostname || null;
  } catch {
    return trimmed
      .replace(/^\*\./, "")
      .replace(/^https?:\/\//i, "")
      .split(/[/:?#]/)[0]
      .trim()
      .toLowerCase() || null;
  }
}

function normalizeDomains(value: unknown): string[] {
  const rawValues = Array.isArray(value) ? value : [value];
  return Array.from(
    new Set(
      rawValues
        .map(normalizeDomain)
        .filter((item): item is string => !!item),
    ),
  );
}

function getDomainScopeFromSecretScope(
  value: unknown,
): BrowserComputerSecretScopeSummary | null {
  if (!isRecord(value)) {
    return null;
  }
  const kind = typeof value.kind === "string" ? value.kind : value.type;
  if (kind === "legacy_global" && value.explicitlyMarked === true) {
    return {
      kind: "legacy_global",
      explicitlyMarked: true,
      source: "secretScope",
    };
  }
  if (kind !== "domain") {
    return null;
  }
  const domains = normalizeDomains(
    value.domains ?? value.domain ?? value.hosts ?? value.origin,
  );
  return domains.length > 0
    ? { kind: "domain", domains, source: "secretScope" }
    : null;
}

export function summarizeBrowserComputerSecretScope(
  args: Record<string, unknown>,
): BrowserComputerSecretScopeSummary {
  const explicitScope = getDomainScopeFromSecretScope(args.secretScope);
  if (explicitScope) {
    return explicitScope;
  }

  if (args.legacyGlobalSecret === true) {
    return {
      kind: "legacy_global",
      explicitlyMarked: true,
      source: "legacyGlobalSecret",
    };
  }

  const directDomains = normalizeDomains(
    args.domainScope ?? args.secretDomain ?? args.secretDomains,
  );
  if (directDomains.length > 0) {
    return {
      kind: "domain",
      domains: directDomains,
      source: "domainScope",
    };
  }

  const urlDomains = normalizeDomains(args.url ?? args.href ?? args.targetUrl);
  if (urlDomains.length > 0) {
    return {
      kind: "domain",
      domains: urlDomains,
      source: "url",
    };
  }

  return {
    kind: "missing_domain_scope",
    required: true,
  };
}

export function summarizeBrowserComputerSecretPlaceholder(
  args: Record<string, unknown>,
): BrowserComputerSecretPlaceholderSummary | null {
  return typeof args.secretRef === "string" && args.secretRef.trim()
    ? {
        placeholder: SECRET_REF_PLACEHOLDER,
        scope: summarizeBrowserComputerSecretScope(args),
      }
    : null;
}

function redactBrowserComputerFormData(value: unknown): unknown {
  if (!isRecord(value)) {
    return "[redacted form data]";
  }

  return Object.fromEntries(
    Object.entries(value).map(([field, fieldValue]) => [
      field,
      redactBrowserComputerTextPreview(fieldValue),
    ]),
  );
}

export function redactBrowserComputerInputArgs(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> | null {
  if (
    !isBrowserComputerToolName(toolName) ||
    !isBrowserComputerInputPayloadAction(args.action)
  ) {
    return null;
  }

  const safeArgs = { ...args };
  if ("text" in safeArgs) {
    safeArgs.text = redactBrowserComputerTextPreview(safeArgs.text);
  }
  if ("formData" in safeArgs) {
    safeArgs.formData = redactBrowserComputerFormData(safeArgs.formData);
  }
  if ("secretRef" in safeArgs) {
    safeArgs.secretRef = SECRET_REF_PLACEHOLDER;
    safeArgs.secretScope = summarizeBrowserComputerSecretScope(args);
    delete safeArgs.domainScope;
    delete safeArgs.secretDomain;
    delete safeArgs.secretDomains;
    delete safeArgs.legacyGlobalSecret;
  }

  return safeArgs;
}

function sanitizePotentiallySensitiveArgs(
  toolName: string,
  args: Record<string, unknown>,
  value: unknown,
  key?: string,
): unknown {
  if (key === "secretRef") {
    return SECRET_REF_PLACEHOLDER;
  }
  if (key === "secretScope") {
    return summarizeBrowserComputerSecretScope({ secretScope: value });
  }
  if (key && SENSITIVE_KEY_PATTERN.test(key)) {
    return "[redacted]";
  }
  if (key && SENSITIVE_PATH_KEY_PATTERN.test(key)) {
    return summarizeBrowserComputerLocalPath(value);
  }
  if (typeof value === "string") {
    const payloadRedacted = redactBrowserComputerInputPayloadsInValue(
      toolName,
      args,
      value,
    );
    if (key && /url|href|uri/i.test(key)) {
      return summarizeBrowserComputerUrl(String(payloadRedacted));
    }
    return payloadRedacted;
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      sanitizePotentiallySensitiveArgs(toolName, args, item),
    );
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, item]) => [
        entryKey,
        sanitizePotentiallySensitiveArgs(toolName, args, item, entryKey),
      ]),
    );
  }
  return value;
}

export function sanitizeBrowserComputerToolArguments(
  toolName: string,
  args: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!isBrowserComputerToolName(toolName) || !args) {
    return args;
  }
  const inputSafeArgs = redactBrowserComputerInputArgs(toolName, args);
  return sanitizePotentiallySensitiveArgs(
    toolName,
    args,
    inputSafeArgs || args,
  ) as Record<string, unknown>;
}

function summarizeBrowserComputerUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return `${url.origin}${url.pathname}`;
    }
    if (url.protocol === "about:" && url.pathname === "blank") {
      return "about:blank";
    }
    if (url.protocol === "blob:") {
      return url.origin !== "null"
        ? `blob:${url.origin}/[redacted]`
        : "blob:[redacted]";
    }
    return `${url.protocol}[redacted]`;
  } catch {
    return value;
  }
}

function summarizeBrowserComputerLocalPath(value: unknown): unknown {
  if (typeof value !== "string") {
    return "[redacted]";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "[redacted]";
  }
  const tail = trimmed
    .replace(/[\\/]+$/g, "")
    .split(/[\\/]/)
    .filter(Boolean)
    .pop();
  return tail ? `.../${tail}` : "[redacted]";
}

function sanitizeSnapshotRef(
  toolName: string,
  args: Record<string, unknown>,
  value: unknown,
): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }
  return {
    url:
      typeof value.url === "string"
        ? summarizeBrowserComputerUrl(
            String(
              redactBrowserComputerInputPayloadsInValue(
                toolName,
                args,
                value.url,
              ),
            ),
          )
        : (value.url ?? null),
    title:
      typeof value.title === "string"
        ? redactBrowserComputerInputPayloadsInValue(toolName, args, value.title)
        : (value.title ?? null),
    appName: value.appName ?? null,
    screenshotPath: value.screenshotPath ?? null,
    capturedAtMs: value.capturedAtMs ?? null,
  };
}

function sanitizeWorkbenchTrace(
  toolName: string,
  args: Record<string, unknown>,
  value: unknown,
): unknown {
  if (!isRecord(value)) {
    return value;
  }

  return {
    id: value.id,
    targetKind: value.targetKind,
    toolName: value.toolName,
    action: value.action,
    mode: value.mode,
    provider: value.provider,
    missingExecutable: value.missingExecutable,
    failureKind: value.failureKind,
    blockingReasons: Array.isArray(value.blockingReasons)
      ? value.blockingReasons.map((item) =>
          sanitizePotentiallySensitiveArgs(toolName, args, item),
        )
      : undefined,
    recommendedAction:
      typeof value.recommendedAction === "string"
        ? redactBrowserComputerInputPayloadsInValue(
            toolName,
            args,
            value.recommendedAction,
          )
        : value.recommendedAction,
    evidenceSummary: Array.isArray(value.evidenceSummary)
      ? value.evidenceSummary.map((item) =>
          sanitizePotentiallySensitiveArgs(toolName, args, item),
        )
      : undefined,
    axQuality: isRecord(value.axQuality)
      ? sanitizePotentiallySensitiveArgs(toolName, args, value.axQuality)
      : (value.axQuality ?? null),
    startedAtMs: value.startedAtMs,
    completedAtMs: value.completedAtMs,
    before: sanitizeSnapshotRef(toolName, args, value.before),
    after: sanitizeSnapshotRef(toolName, args, value.after),
    params: sanitizePotentiallySensitiveArgs(
      typeof value.toolName === "string" ? value.toolName : toolName,
      args,
      isRecord(value.params) ? value.params : {},
    ),
    success: value.success,
    error:
      typeof value.error === "string"
        ? redactBrowserComputerInputPayloadsInValue(toolName, args, value.error)
        : (value.error ?? null),
    screenshotPath: value.screenshotPath ?? null,
    agentPointerEvent: sanitizeBrowserComputerMetadataValue(
      toolName,
      args,
      value.agentPointerEvent,
      "agentPointerEvent",
    ),
    consoleErrors: Array.isArray(value.consoleErrors)
      ? value.consoleErrors.map((item) =>
          sanitizePotentiallySensitiveArgs(toolName, args, item),
        )
      : undefined,
    networkFailures: Array.isArray(value.networkFailures)
      ? value.networkFailures.map((item) =>
          sanitizePotentiallySensitiveArgs(toolName, args, item),
        )
      : undefined,
  };
}

function sanitizeRecoveryOutcome(
  toolName: string,
  args: Record<string, unknown>,
  value: unknown,
): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const safeEvidence = Array.isArray(value.evidence)
    ? value.evidence
        .map((item) => sanitizeRecoveryEvidence(toolName, args, item))
        .filter((item): item is string => typeof item === "string" && item.length > 0)
    : undefined;

  return {
    status: value.status,
    title:
      typeof value.title === "string"
        ? redactBrowserComputerInputPayloadsInValue(toolName, args, value.title)
        : value.title,
    evidence: safeEvidence,
    retryHint:
      typeof value.retryHint === "string"
        ? redactBrowserComputerInputPayloadsInValue(
            toolName,
            args,
            value.retryHint,
          )
        : value.retryHint,
    noEvidence: value.noEvidence === true,
  };
}

function sanitizeRecoveryEvidence(
  toolName: string,
  args: Record<string, unknown>,
  value: unknown,
): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const redacted = redactBrowserComputerInputPayloadsInValue(toolName, args, value);
  const text = typeof redacted === "string" ? redacted.trim() : "";
  if (!text) {
    return null;
  }
  if (/^(DOM headings|Interactive elements|Accessibility snapshot|Candidates|Target app|TargetRef|Snapshot|App|Mode|Status):/i.test(text)) {
    return text;
  }
  if (/^只打开了状态面板/.test(text)) {
    return text;
  }
  return null;
}

function isEvidenceRefRecord(value: unknown): value is EvidenceRef {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && typeof value.kind === "string"
    && typeof value.ref === "string"
    && typeof value.source === "string"
    && isRecord(value.freshness)
    && typeof value.redactionStatus === "string";
}

function sanitizeEvidenceRefTarget(value: string): string {
  if (/^data:/i.test(value) || /base64/i.test(value)) {
    return "[redacted]";
  }
  if (/storageState|storage-state|cookie|localStorage|sessionStorage/i.test(value)) {
    return String(summarizeBrowserComputerLocalPath(value));
  }
  if (/^(\/Users\/|\/home\/|\/var\/folders\/|\/tmp\/|[A-Za-z]:[\\/])/.test(value)) {
    return String(summarizeBrowserComputerLocalPath(value));
  }
  return value;
}

function sanitizeEvidenceRef(value: EvidenceRef): EvidenceRef {
  return {
    ...value,
    ref: sanitizeEvidenceRefTarget(value.ref),
  };
}

function sanitizeBrowserComputerMetadataValue(
  toolName: string,
  args: Record<string, unknown>,
  value: unknown,
  key?: string,
): unknown {
  if (isEvidenceRefRecord(value)) {
    return sanitizeEvidenceRef(value);
  }
  if (key && RAW_BROWSER_COMPUTER_METADATA_KEYS.has(key)) {
    return OMIT;
  }
  if (key === "secretRef") {
    return SECRET_REF_PLACEHOLDER;
  }
  if (key === "secretScope") {
    return summarizeBrowserComputerSecretScope({ secretScope: value });
  }
  if (key && SENSITIVE_KEY_PATTERN.test(key)) {
    return "[redacted]";
  }
  if (key && SENSITIVE_PATH_KEY_PATTERN.test(key)) {
    return summarizeBrowserComputerLocalPath(value);
  }
  if (
    key === "workbenchTrace" ||
    (isRecord(value) && value.targetKind && value.startedAtMs)
  ) {
    return sanitizeWorkbenchTrace(toolName, args, value);
  }
  if (key === "browserComputerRecoveryActionOutcome") {
    return sanitizeRecoveryOutcome(toolName, args, value);
  }
  if (key === "computerSurfaceSnapshot") {
    return sanitizeSnapshotRef(toolName, args, value);
  }
  if (typeof value === "string") {
    const payloadRedacted = redactBrowserComputerInputPayloadsInValue(
      toolName,
      args,
      value,
    );
    if (key && /url|href|uri/i.test(key)) {
      return summarizeBrowserComputerUrl(String(payloadRedacted));
    }
    return payloadRedacted;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeBrowserComputerMetadataValue(toolName, args, item))
      .filter((item) => item !== OMIT);
  }
  if (isRecord(value)) {
    const entries: Array<[string, unknown]> = [];
    for (const [entryKey, item] of Object.entries(value)) {
      const sanitized = sanitizeBrowserComputerMetadataValue(
        toolName,
        args,
        item,
        entryKey,
      );
      if (sanitized !== OMIT) {
        entries.push([entryKey, sanitized]);
      }
    }
    return Object.fromEntries(entries);
  }
  return value;
}

export function sanitizeBrowserComputerMetadata(
  toolName: string,
  args: Record<string, unknown> | undefined,
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!isBrowserComputerToolName(toolName) || !metadata) {
    return metadata;
  }
  const safeArgs = args || {};
  return sanitizeBrowserComputerMetadataValue(
    toolName,
    safeArgs,
    metadata,
  ) as Record<string, unknown>;
}

export function sanitizeBrowserComputerToolResult<
  T extends {
    output?: string;
    error?: string;
    metadata?: Record<string, unknown>;
  },
>(toolName: string, args: Record<string, unknown> | undefined, result: T): T {
  if (!isBrowserComputerToolName(toolName)) {
    return result;
  }
  const safeArgs = args || {};
  const output = redactBrowserComputerInputPayloadsInValue(
    toolName,
    safeArgs,
    result.output,
  );
  const error = redactBrowserComputerInputPayloadsInValue(
    toolName,
    safeArgs,
    result.error,
  );
  return {
    ...result,
    output: typeof output === "string" ? output : result.output,
    error: typeof error === "string" ? error : result.error,
    metadata: sanitizeBrowserComputerMetadata(
      toolName,
      safeArgs,
      result.metadata,
    ),
  };
}

interface BrowserComputerSensitiveLiteral {
  value: string;
  replacement: string;
}

function collectBrowserComputerInputPayloads(
  toolName: string,
  args: Record<string, unknown>,
): BrowserComputerSensitiveLiteral[] {
  if (
    !isBrowserComputerToolName(toolName) ||
    !isBrowserComputerInputPayloadAction(args.action)
  ) {
    return [];
  }

  const values = new Map<string, string>();
  if (typeof args.text === "string" && args.text) {
    values.set(args.text, redactBrowserComputerTextPreview(args.text));
  }
  if (isRecord(args.formData)) {
    for (const value of Object.values(args.formData)) {
      if (typeof value === "string" && value) {
        values.set(value, redactBrowserComputerTextPreview(value));
      }
    }
  }
  if (typeof args.secretRef === "string" && args.secretRef) {
    values.set(args.secretRef, SECRET_REF_PLACEHOLDER);
  }

  return [...values.entries()]
    .map(([value, replacement]) => ({ value, replacement }))
    .sort((a, b) => b.value.length - a.value.length);
}

function redactPayloadsInString(
  value: string,
  payloads: BrowserComputerSensitiveLiteral[],
): string {
  let redacted = value;
  for (const payload of payloads) {
    redacted = redacted
      .split(payload.value)
      .join(payload.replacement);
  }
  return redacted;
}

export function redactBrowserComputerInputPayloadsInValue(
  toolName: string,
  args: Record<string, unknown>,
  value: unknown,
): unknown {
  const payloads = collectBrowserComputerInputPayloads(toolName, args);
  if (payloads.length === 0) {
    return value;
  }

  if (typeof value === "string") {
    return redactPayloadsInString(value, payloads);
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      redactBrowserComputerInputPayloadsInValue(toolName, args, item),
    );
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactBrowserComputerInputPayloadsInValue(toolName, args, item),
      ]),
    );
  }
  return value;
}
