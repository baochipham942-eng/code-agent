import { VOICE_XML_FALLBACK_MAX_CHARS } from '../../../shared/constants/voice';
import type { VoiceToolDefinition } from '../../../shared/contract/voice';
import { validateToolInputSchema } from '../../tools/toolSchemaValidator';

export const VOICE_XML_FALLBACK_TOOL_NAMES = [
  'delegate_task',
  'steer_task',
  'cancel_task',
  'task_status',
] as const;

type FallbackToolName = typeof VOICE_XML_FALLBACK_TOOL_NAMES[number];

export type VoiceXmlFallbackResult =
  | { kind: 'not_candidate' }
  | { kind: 'rejected'; reason: 'too_large' | 'malformed' | 'unsupported_tool' | 'schema_mismatch'; toolName?: string }
  | { kind: 'accepted'; name: FallbackToolName; arguments: string };

export type VoiceToolArgumentsValidation =
  | { ok: true; arguments: string }
  | { ok: false; reason: 'unregistered_tool' | 'malformed_json' | 'schema_mismatch' };

const ALLOWED_NAMES = new Set<string>(VOICE_XML_FALLBACK_TOOL_NAMES);
const INVOKE_PATTERN = /^\s*<invoke name="([a-z_][a-z0-9_]*)">([\s\S]*)<\/invoke>\s*$/;
const PARAMETER_PATTERN = /^<parameter name="([a-z_][a-z0-9_]*)">([^<]*)<\/parameter>/;
const ENTITY_PATTERN = /&(#\d+|#x[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g;

export function mayBeVoiceXmlFallback(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.length > 0 && ('<invoke'.startsWith(trimmed) || trimmed.startsWith('<invoke'));
}

export function parseVoiceXmlToolFallback(
  text: string,
  registeredTools: readonly VoiceToolDefinition[],
): VoiceXmlFallbackResult {
  if (!mayBeVoiceXmlFallback(text)) return { kind: 'not_candidate' };
  if (text.length > VOICE_XML_FALLBACK_MAX_CHARS) return { kind: 'rejected', reason: 'too_large' };

  const invoke = INVOKE_PATTERN.exec(text);
  if (!invoke) return { kind: 'rejected', reason: 'malformed' };
  const toolName = invoke[1];
  if (!ALLOWED_NAMES.has(toolName)) return { kind: 'rejected', reason: 'unsupported_tool', toolName };

  const definition = registeredTools.find((tool) => tool.name === toolName);
  if (!definition) return { kind: 'rejected', reason: 'unsupported_tool', toolName };
  const parsedParameters = parseParameters(invoke[2], definition);
  if (!parsedParameters) return { kind: 'rejected', reason: 'malformed', toolName };

  const validation = validateVoiceToolArguments(toolName, JSON.stringify(parsedParameters), registeredTools);
  if (!validation.ok) return { kind: 'rejected', reason: 'schema_mismatch', toolName };
  return { kind: 'accepted', name: toolName as FallbackToolName, arguments: JSON.stringify(parsedParameters) };
}

export function validateVoiceToolArguments(
  name: string,
  rawArguments: string,
  registeredTools: readonly VoiceToolDefinition[],
): VoiceToolArgumentsValidation {
  const definition = registeredTools.find((tool) => tool.name === name);
  if (!definition) return { ok: false, reason: 'unregistered_tool' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments || '{}') as unknown;
  } catch {
    return { ok: false, reason: 'malformed_json' };
  }
  const issues = validateToolInputSchema(definition.parameters, parsed);
  if (issues.length > 0) return { ok: false, reason: 'schema_mismatch' };
  return { ok: true, arguments: JSON.stringify(parsed) };
}

function parseParameters(
  body: string,
  definition: VoiceToolDefinition,
): Record<string, unknown> | null {
  const params: Record<string, unknown> = {};
  let remaining = body;
  while (remaining.trim().length > 0) {
    remaining = remaining.trimStart();
    const match = PARAMETER_PATTERN.exec(remaining);
    if (!match) return null;
    const [, name, encodedValue] = match;
    if (Object.prototype.hasOwnProperty.call(params, name)) return null;
    const property = definition.parameters.properties[name] as { type?: unknown } | undefined;
    if (!property || typeof property.type !== 'string') return null;
    const value = decodeXmlText(encodedValue);
    if (value === null) return null;
    if (property.type === 'boolean') {
      if (value !== 'true' && value !== 'false') return null;
      params[name] = value === 'true';
    } else if (property.type === 'string') {
      params[name] = value;
    } else {
      return null;
    }
    remaining = remaining.slice(match[0].length);
  }
  return params;
}

function decodeXmlText(value: string): string | null {
  let valid = true;
  const decoded = value.replace(ENTITY_PATTERN, (_whole, entity: string) => {
    if (entity === 'amp') return '&';
    if (entity === 'lt') return '<';
    if (entity === 'gt') return '>';
    if (entity === 'quot') return '"';
    if (entity === 'apos') return "'";
    const radix = entity.startsWith('#x') ? 16 : 10;
    const digits = entity.slice(radix === 16 ? 2 : 1);
    const codePoint = Number.parseInt(digits, radix);
    if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
      valid = false;
      return '';
    }
    return String.fromCodePoint(codePoint);
  });
  const withoutKnownEntities = value.replace(ENTITY_PATTERN, '');
  if (!valid || withoutKnownEntities.includes('&')) return null;
  return decoded;
}
