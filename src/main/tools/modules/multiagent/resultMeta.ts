import type { ToolContext, ToolResult } from '../../../protocol/tools';
import type { ToolArtifact } from '../../../../shared/contract/artifactBlob';
import { createVirtualArtifact } from '../../artifacts/artifactMeta';

type SuccessResult = Extract<ToolResult<string>, { ok: true }>;

const SENSITIVE_KEY_PATTERN = /(api[-_]?key|token|secret|password|authorization|cookie|base64)/i;
const CONTENT_KEY_PATTERN = /(prompt|task|message|content|text|input|output|description)/i;
const STRING_PREVIEW_LIMIT = 160;

interface MultiagentMetaOptions {
  artifactName?: string;
  requestArgs?: Record<string, unknown>;
  legacyMetadata?: Record<string, unknown>;
  legacyContext?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function summarizeValue(key: string, value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;

  if (typeof value === 'string') {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      return { redacted: true, length: value.length };
    }
    if (CONTENT_KEY_PATTERN.test(key)) {
      return {
        type: 'string',
        length: value.length,
        preview: value.slice(0, STRING_PREVIEW_LIMIT),
      };
    }
    if (value.length > STRING_PREVIEW_LIMIT) {
      return { type: 'string', length: value.length, preview: value.slice(0, STRING_PREVIEW_LIMIT) };
    }
    return value;
  }

  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length,
      preview: value.slice(0, 5).map((item, index) => summarizeValue(`${key}[${index}]`, item)),
    };
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .map(([childKey, childValue]) => [childKey, summarizeValue(childKey, childValue)])
        .filter(([, childValue]) => childValue !== undefined),
    );
  }

  return { type: typeof value };
}

function buildRequestSummary(args?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!args) return undefined;
  return {
    args: Object.fromEntries(
      Object.entries(args)
        .map(([key, value]) => [key, summarizeValue(key, value)])
        .filter(([, value]) => value !== undefined),
    ),
  };
}

function normalizeTargets(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const targets = Array.from(new Set(value.filter((target): target is string => typeof target === 'string' && target.length > 0)));
  return targets.length > 0 ? targets : undefined;
}

function normalizeCounts(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const counts = Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])),
  );
  return Object.keys(counts).length > 0 ? counts : undefined;
}

function normalizeOptions(value?: string | MultiagentMetaOptions): MultiagentMetaOptions {
  if (typeof value === 'string') return { artifactName: value };
  return value ?? {};
}

function compactArtifactMetadata(meta: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries({
      tool: meta.tool,
      category: meta.category,
      action: meta.action,
      status: meta.status,
      session: meta.session,
      thread: meta.thread,
      agentId: meta.agentId,
      targets: meta.targets,
      counts: meta.counts,
      bridge: meta.bridge,
      artifactRole: meta.artifactRole,
    }).filter(([, value]) => value !== undefined),
  );
}

export function textArtifact(
  sourceTool: string,
  ctx: ToolContext,
  name: string,
  output: string,
  metadata: Record<string, unknown>,
) {
  return createVirtualArtifact({
    sourceTool,
    kind: 'text',
    sessionId: ctx.sessionId,
    name,
    mimeType: 'text/plain',
    contentLength: output.length,
    preview: output.slice(0, 500),
    metadata,
  });
}

export function withMultiagentMeta(
  result: ToolResult<string>,
  ctx: ToolContext,
  sourceTool: string,
  meta: Record<string, unknown>,
  artifactNameOrOptions?: string | MultiagentMetaOptions,
): ToolResult<string> {
  const options = normalizeOptions(artifactNameOrOptions);
  const targets = normalizeTargets(meta.targets);
  const counts = normalizeCounts(meta.counts);
  const baseMeta = { ...meta };
  delete baseMeta.targets;
  delete baseMeta.counts;

  const structuredMeta = {
    tool: sourceTool,
    category: 'multiagent',
    session: ctx.sessionId,
    thread: ctx.currentToolCallId,
    ...baseMeta,
    ...(targets ? { targets } : {}),
    ...(counts ? { counts } : {}),
    ...(options.requestArgs ? { request: buildRequestSummary(options.requestArgs) } : {}),
    ...(options.legacyMetadata ? { legacyMetadata: options.legacyMetadata } : {}),
    bridge: {
      protocolContext: true,
      legacyContext: options.legacyContext ?? Boolean(options.legacyMetadata),
    },
    artifactRole: 'multiagent-result',
  };

  if (!result.ok) {
    return {
      ...result,
      meta: {
        ...(result.meta ?? {}),
        ...structuredMeta,
      },
    };
  }

  const artifact: ToolArtifact = textArtifact(
    sourceTool,
    ctx,
    options.artifactName ?? `${sourceTool} result`,
    result.output,
    compactArtifactMetadata(structuredMeta),
  );

  return {
    ...result,
    meta: {
      ...(result.meta ?? {}),
      ...structuredMeta,
      artifact,
      artifacts: [artifact],
    },
  } satisfies SuccessResult;
}
