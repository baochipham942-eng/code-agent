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
  "cookie",
  "cookies",
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

function sanitizeBrowserComputerMetadataValue(
  toolName: string,
  args: Record<string, unknown>,
  value: unknown,
  key?: string,
): unknown {
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

const LARGE_TEXT_TOOL_NAMES = new Set([
  'Edit',
  'edit_file',
  'Write',
  'write_file',
  'Append',
]);

function summarizeLargeText(value: string, head = 160, tail = 80): string {
  if (value.length <= head + tail + 32) {
    return value;
  }
  const omitted = value.length - head - tail;
  return `${value.slice(0, head)}...[${omitted} chars omitted]...${value.slice(-tail)}`;
}


function summarizeEditEntries(edits: unknown): unknown {
  if (!Array.isArray(edits)) {
    return edits;
  }
  return edits.map((edit) => {
    if (!isRecord(edit)) {
      return edit;
    }
    const summarized: Record<string, unknown> = { ...edit };
    if (typeof edit.old_text === 'string') {
      summarized.old_text = summarizeLargeText(edit.old_text);
      summarized.old_text_length = edit.old_text.length;
    }
    if (typeof edit.new_text === 'string') {
      summarized.new_text = summarizeLargeText(edit.new_text);
      summarized.new_text_length = edit.new_text.length;
    }
    return summarized;
  });
}

export function sanitizeLargeTextToolArguments(
  toolName: string,
  args: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!args || !LARGE_TEXT_TOOL_NAMES.has(toolName)) {
    return args;
  }

  const safeArgs: Record<string, unknown> = { ...args };

  if (typeof args.content === 'string') {
    const summarized = summarizeLargeText(args.content);
    safeArgs.content = summarized;
    safeArgs.content_length = args.content.length;
    // 只有当 content 真被截断成片段时，UI 才无法从 args.content 算出真实行数
    // （会显示 12 而非几百行）。此时留下权威总行数，供工具卡片 / TurnDiffSummary
    // 展示。未截断的小文件不设此字段，沿用原有逐行计算，行为不变。
    if (summarized !== args.content) {
      safeArgs.content_lines = args.content.split('\n').length;
    }
  }

  if (Array.isArray(args.edits)) {
    safeArgs.edits = summarizeEditEntries(args.edits);
  }

  if (typeof args.old_text === 'string') {
    safeArgs.old_text = summarizeLargeText(args.old_text);
    safeArgs.old_text_length = args.old_text.length;
  }

  if (typeof args.new_text === 'string') {
    safeArgs.new_text = summarizeLargeText(args.new_text);
    safeArgs.new_text_length = args.new_text.length;
  }

  return safeArgs;
}
