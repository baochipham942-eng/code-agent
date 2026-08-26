import type { ToolCallTargetContext, ToolStepLabelKey } from '../../../shared/contract';
import { resolveProtocolToolStepLabel } from '../../tools/protocolToolRegistration';
import { logger } from './providerRuntime';

export interface ExtractedToolCallMeta {
  arguments: Record<string, unknown>;
  shortDescription?: string;
  stepLabel?: ToolStepLabelKey;
  targetContext?: ToolCallTargetContext;
  expectedOutcome?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype: object | null = Object.getPrototypeOf(value as object) as object | null;
  return prototype === Object.prototype || prototype === null;
}

/**
 * Provider tool-call envelope chokepoint.
 *
 * `_meta` belongs to the UI envelope and must never reach tool business arguments.
 * Only a plain object contributes semantic fields; malformed values are stripped and
 * reported so provider drift stays observable without turning into a tool failure.
 */
export function extractToolCallMeta(
  rawArguments: unknown,
  toolName: string,
): ExtractedToolCallMeta {
  const args = isPlainObject(rawArguments) ? { ...rawArguments } : {};
  const stepLabel = resolveProtocolToolStepLabel(toolName, args);
  if (!Object.prototype.hasOwnProperty.call(args, '_meta')) {
    return {
      arguments: args,
      ...(stepLabel !== undefined && { stepLabel }),
    };
  }

  const meta = args._meta;
  delete args._meta;

  if (!isPlainObject(meta)) {
    logger.warn('[extractToolCallMeta] Ignoring invalid tool-call _meta envelope', {
      receivedType: meta === null ? 'null' : Array.isArray(meta) ? 'array' : typeof meta,
    });
    return {
      arguments: args,
      ...(stepLabel !== undefined && { stepLabel }),
    };
  }

  const shortDescription = typeof meta.shortDescription === 'string'
    ? meta.shortDescription
    : undefined;
  const expectedOutcome = typeof meta.expectedOutcome === 'string'
    ? meta.expectedOutcome
    : undefined;
  const targetContext = isPlainObject(meta.targetContext)
    ? meta.targetContext as ToolCallTargetContext
    : undefined;

  return {
    arguments: args,
    ...(shortDescription !== undefined && { shortDescription }),
    ...(stepLabel !== undefined && { stepLabel }),
    ...(targetContext !== undefined && { targetContext }),
    ...(expectedOutcome !== undefined && { expectedOutcome }),
  };
}
