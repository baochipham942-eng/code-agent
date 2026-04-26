const BROWSER_COMPUTER_TOOLS = new Set(["browser_action", "computer_use"]);
const INPUT_PAYLOAD_ACTIONS = new Set(["type", "smart_type", "fill_form"]);
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
    safeArgs.secretRef = "[secretRef]";
  }

  return safeArgs;
}

function sanitizePotentiallySensitiveArgs(
  toolName: string,
  args: Record<string, unknown>,
  value: unknown,
  key?: string,
): unknown {
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

function collectBrowserComputerInputPayloads(
  toolName: string,
  args: Record<string, unknown>,
): string[] {
  if (
    !isBrowserComputerToolName(toolName) ||
    !isBrowserComputerInputPayloadAction(args.action)
  ) {
    return [];
  }

  const values = new Set<string>();
  if (typeof args.text === "string" && args.text) {
    values.add(args.text);
  }
  if (isRecord(args.formData)) {
    for (const value of Object.values(args.formData)) {
      if (typeof value === "string" && value) {
        values.add(value);
      }
    }
  }

  return [...values].sort((a, b) => b.length - a.length);
}

function redactPayloadsInString(value: string, payloads: string[]): string {
  let redacted = value;
  for (const payload of payloads) {
    redacted = redacted
      .split(payload)
      .join(redactBrowserComputerTextPreview(payload));
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
