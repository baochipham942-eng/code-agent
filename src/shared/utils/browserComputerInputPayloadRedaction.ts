import { redactBrowserCookiePayloadsInText } from './browserComputerCookieRedaction';
import { redactSurfaceExecutionCanaryText } from './surfaceExecutionRedaction';

const BROWSER_COMPUTER_TOOLS = new Set(['browser_action', 'computer_use']);
const INPUT_PAYLOAD_ACTIONS = new Set([
  'type',
  'smart_type',
  'fill_form',
  'write_clipboard',
  'handle_dialog',
]);
const SECRET_REF_PLACEHOLDER = '[secretRef]';

interface BrowserComputerSensitiveLiteral {
  value: string;
  replacement: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function isBrowserComputerToolName(
  toolName: unknown,
): toolName is 'browser_action' | 'computer_use' {
  return typeof toolName === 'string' && BROWSER_COMPUTER_TOOLS.has(toolName);
}

export function isBrowserComputerInputPayloadAction(action: unknown): boolean {
  return typeof action === 'string' && INPUT_PAYLOAD_ACTIONS.has(action);
}

export function redactBrowserComputerTextPreview(value: unknown): string {
  const text = typeof value === 'string' ? value : '';
  return text ? `[redacted ${text.length} chars]` : '[redacted text]';
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
  if (typeof args.text === 'string' && args.text) {
    values.set(args.text, redactBrowserComputerTextPreview(args.text));
  }
  if (typeof args.clipboardText === 'string' && args.clipboardText) {
    values.set(
      args.clipboardText,
      redactBrowserComputerTextPreview(args.clipboardText),
    );
  }
  if (typeof args.dialogPromptText === 'string' && args.dialogPromptText) {
    values.set(
      args.dialogPromptText,
      redactBrowserComputerTextPreview(args.dialogPromptText),
    );
  }
  if (isRecord(args.formData)) {
    for (const value of Object.values(args.formData)) {
      if (typeof value === 'string' && value) {
        values.set(value, redactBrowserComputerTextPreview(value));
      }
    }
  }
  if (typeof args.secretRef === 'string' && args.secretRef) {
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
    redacted = redacted.split(payload.value).join(payload.replacement);
  }
  return redacted;
}

export function redactBrowserComputerInputPayloadsInValue(
  toolName: string,
  args: Record<string, unknown>,
  value: unknown,
): unknown {
  const payloads = collectBrowserComputerInputPayloads(toolName, args);
  const applySafeText =
    isBrowserComputerToolName(toolName) && typeof value === 'string'
      ? (text: string) => redactSurfaceExecutionCanaryText(
          redactBrowserCookiePayloadsInText(text),
        )
      : (text: string) => text;

  if (payloads.length === 0) {
    if (typeof value === 'string' && isBrowserComputerToolName(toolName)) {
      return applySafeText(value);
    }
    return value;
  }

  if (typeof value === 'string') {
    return applySafeText(redactPayloadsInString(value, payloads));
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
