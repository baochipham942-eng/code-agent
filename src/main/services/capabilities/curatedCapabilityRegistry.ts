// ============================================================================
// Local curated capability registry reader
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import type {
  CapabilityCenterDiagnostic,
  CapabilityCenterItem,
  CapabilityInstallDraftSpec,
  CapabilityInstallDraftParameter,
  CapabilityInstallPlan,
  CapabilityKind,
  CapabilityPermission,
  CapabilityRequirement,
  CapabilityRiskInfo,
  CapabilitySourceKind,
} from '../../../shared/contract/capability';
import { createLogger } from '../infra/logger';

const logger = createLogger('CuratedCapabilityRegistry');

type CuratedCapabilityKind = Extract<CapabilityKind, 'mcp_template' | 'channel_adapter' | 'workflow_recipe'>;
type RegistryCapabilitySourceKind = Extract<CapabilitySourceKind, 'curated' | 'marketplace' | 'remote' | 'team'>;

interface CuratedRegistryRequirement {
  kind?: unknown;
  label?: unknown;
  value?: unknown;
  status?: unknown;
  sensitive?: unknown;
}

interface CuratedRegistryPermission {
  label?: unknown;
  level?: unknown;
  detail?: unknown;
}

interface CuratedRegistryRisk {
  tier?: unknown;
  reasons?: unknown;
  dataTouched?: unknown;
}

interface CuratedRegistryItem {
  id?: unknown;
  kind?: unknown;
  name?: unknown;
  summary?: unknown;
  description?: unknown;
  tags?: unknown;
  permissions?: unknown;
  config?: unknown;
  dependencies?: unknown;
  risk?: unknown;
  source?: unknown;
  audit?: unknown;
  install?: unknown;
}

interface CuratedRegistryFile {
  version?: unknown;
  source?: unknown;
  items?: unknown;
  revokedIds?: unknown;
}

interface CuratedRegistryReadResult {
  items: CapabilityCenterItem[];
  diagnostics: CapabilityCenterDiagnostic[];
}

export interface ParsedCapabilityRegistrySourceTrust {
  contentHash?: string;
  expiresAt?: string;
  signedAt?: string;
  keyId?: string;
  signature?: string;
}

export interface ParseCapabilityRegistryPayloadOptions {
  sourcePath: string;
  sourceKind: RegistryCapabilitySourceKind;
  idPrefix: string;
  registryFileHash: string;
  trustMode: 'source_metadata' | 'trusted_envelope';
  sourceTrust?: ParsedCapabilityRegistrySourceTrust;
}

function encodeCapabilityId(prefix: string, rawId: string): string {
  return `${prefix}:${encodeURIComponent(rawId)}`;
}

function sourceLabel(kind: RegistryCapabilitySourceKind): string {
  switch (kind) {
    case 'curated':
      return '本地 curated registry';
    case 'marketplace':
      return 'Marketplace';
    case 'team':
      return '团队 registry';
    case 'remote':
      return '远程 registry';
  }
}

function unique(values: Array<string | undefined | null>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value)))).sort();
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => asString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function diagnostic(args: Omit<CapabilityCenterDiagnostic, 'source' | 'severity'> & {
  severity?: CapabilityCenterDiagnostic['severity'];
}): CapabilityCenterDiagnostic {
  return {
    source: 'registry',
    severity: args.severity ?? 'warning',
    code: args.code,
    message: args.message,
    ...(args.path ? { path: args.path } : {}),
    ...(args.itemId ? { itemId: args.itemId } : {}),
    ...(args.blocking ? { blocking: args.blocking } : {}),
    ...(args.expectedHash ? { expectedHash: args.expectedHash } : {}),
    ...(args.actualHash ? { actualHash: args.actualHash } : {}),
  };
}

function stripContentHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stripContentHash(entry));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'contentHash')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stripContentHash(entry)]),
  );
}

function buildRegistryFileHash(parsed: unknown): string {
  return `sha256:${crypto
    .createHash('sha256')
    .update(JSON.stringify(stripContentHash(parsed)))
    .digest('hex')}`;
}

function isSha256ContentHash(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/i.test(value);
}

function buildContentHashDiagnostics(
  filePath: string,
  expectedHash: string | undefined,
  actualHash: string,
  required: boolean,
): CapabilityCenterDiagnostic[] {
  if (!expectedHash) {
    if (!required) {
      return [];
    }
    return [diagnostic({
      code: 'missing_content_hash',
      message: 'Registry source.contentHash is required before installable MCP templates can generate drafts.',
      path: filePath,
      severity: 'error',
      blocking: true,
      actualHash,
    })];
  }

  const blocksDraft = required;
  const severity: CapabilityCenterDiagnostic['severity'] = blocksDraft ? 'error' : 'warning';
  if (!isSha256ContentHash(expectedHash)) {
    return [diagnostic({
      code: 'invalid_content_hash',
      message: 'Registry source.contentHash must use sha256:<64 hex chars>.',
      path: filePath,
      severity,
      blocking: blocksDraft,
      expectedHash,
      actualHash,
    })];
  }

  if (expectedHash.toLowerCase() !== actualHash) {
    return [diagnostic({
      code: 'content_hash_mismatch',
      message: 'Registry source.contentHash does not match the canonical local registry content hash.',
      path: filePath,
      severity,
      blocking: blocksDraft,
      expectedHash,
      actualHash,
    })];
  }

  return [];
}

function buildExpiresAtDiagnostics(
  filePath: string,
  expiresAt: string | undefined,
  required: boolean,
): CapabilityCenterDiagnostic[] {
  if (!required) {
    return [];
  }

  if (!expiresAt) {
    return [diagnostic({
      code: 'missing_expires_at',
      message: 'Registry source.expiresAt is required before installable MCP templates can generate drafts.',
      path: filePath,
      severity: 'error',
      blocking: true,
    })];
  }

  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    return [diagnostic({
      code: 'invalid_expires_at',
      message: 'Registry source.expiresAt must be a valid date string.',
      path: filePath,
      severity: 'error',
      blocking: true,
    })];
  }

  if (expiresAtMs <= Date.now()) {
    return [diagnostic({
      code: 'expired_registry',
      message: 'Registry source.expiresAt is in the past.',
      path: filePath,
      severity: 'error',
      blocking: true,
    })];
  }

  return [];
}

function hasMcpDraftCandidate(raw: CuratedRegistryItem): boolean {
  if (raw.kind !== 'mcp_template') {
    return false;
  }
  const install = asRecord(raw.install);
  return Object.keys(asRecord(install.mcpServer)).length > 0;
}

function buildTrustBlockReason(diagnostics: CapabilityCenterDiagnostic[]): string | undefined {
  const blockingCodes = unique(diagnostics
    .filter((entry) => entry.blocking)
    .map((entry) => entry.code));
  if (blockingCodes.length === 0) {
    return undefined;
  }
  return `Registry trust metadata blocked draft generation: ${blockingCodes.join(', ')}`;
}

function parseRevokedIds(value: unknown, filePath: string): {
  revokedIds: Set<string>;
  diagnostics: CapabilityCenterDiagnostic[];
} {
  if (value === undefined) {
    return { revokedIds: new Set(), diagnostics: [] };
  }
  if (!Array.isArray(value)) {
    return {
      revokedIds: new Set(),
      diagnostics: [diagnostic({
        code: 'invalid_revoked_ids',
        message: 'Registry revokedIds must be an array of strings.',
        path: filePath,
        severity: 'error',
      })],
    };
  }

  const revokedIds = new Set<string>();
  const diagnostics: CapabilityCenterDiagnostic[] = [];
  value.forEach((entry, index) => {
    const id = asString(entry);
    if (!id) {
      diagnostics.push(diagnostic({
        code: 'invalid_revoked_id',
        message: 'Skipped revokedIds entry because it is not a non-empty string.',
        path: `${filePath}#revokedIds[${index}]`,
        severity: 'warning',
      }));
      return;
    }
    revokedIds.add(id);
  });
  return { revokedIds, diagnostics };
}

function isRevokedRegistryItem(raw: CuratedRegistryItem, revokedIds: Set<string>): string | null {
  const id = asString(raw.id);
  if (!id) {
    return null;
  }
  const kind = asString(raw.kind);
  if (revokedIds.has(id) || (kind && revokedIds.has(`${kind}:${id}`))) {
    return id;
  }
  return null;
}

function isRequirementKind(value: unknown): value is CapabilityRequirement['kind'] {
  return value === 'env'
    || value === 'secret'
    || value === 'binary'
    || value === 'path'
    || value === 'network'
    || value === 'account'
    || value === 'config';
}

function isRequirementStatus(value: unknown): value is CapabilityRequirement['status'] {
  return value === 'met' || value === 'missing' || value === 'unknown' || value === 'not_applicable';
}

function isRiskTier(value: unknown): value is CapabilityRiskInfo['tier'] {
  return value === 'low' || value === 'medium' || value === 'high';
}

function isCuratedKind(value: unknown): value is CuratedCapabilityKind {
  return value === 'mcp_template' || value === 'channel_adapter' || value === 'workflow_recipe';
}

function containsTemplatePlaceholder(value: unknown): boolean {
  if (typeof value === 'string') {
    return /\{\{[^}]+\}\}/.test(value);
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsTemplatePlaceholder(entry));
  }
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((entry) => containsTemplatePlaceholder(entry));
  }
  return false;
}

function extractTemplatePlaceholders(value: unknown): string[] {
  const placeholders = new Set<string>();
  const visit = (entry: unknown): void => {
    if (typeof entry === 'string') {
      for (const match of entry.matchAll(/\{\{([^}]+)\}\}/g)) {
        const key = match[1]?.trim();
        if (key) placeholders.add(key);
      }
      return;
    }
    if (Array.isArray(entry)) {
      entry.forEach(visit);
      return;
    }
    if (entry && typeof entry === 'object') {
      Object.values(entry as Record<string, unknown>).forEach(visit);
    }
  };
  visit(value);
  return Array.from(placeholders).sort();
}

function isSafeMcpServerName(value: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(value);
}

function isSafeTemplateParameterKey(value: string): boolean {
  return /^[a-zA-Z0-9_.-]+$/.test(value);
}

function buildDraftParameters(
  placeholderKeys: string[],
  requirements: CapabilityRequirement[],
): CapabilityInstallDraftParameter[] | null {
  const requirementByLabel = new Map(requirements.map((entry) => [entry.label, entry]));
  const parameters: CapabilityInstallDraftParameter[] = [];
  for (const key of placeholderKeys) {
    if (!isSafeTemplateParameterKey(key)) {
      return null;
    }
    const requirement = requirementByLabel.get(key);
    if (!requirement) {
      return null;
    }
    const kind = requirement?.kind || 'config';
    if (requirement?.sensitive || kind === 'secret' || kind === 'env') {
      return null;
    }
    parameters.push({
      key,
      label: requirement?.label || key,
      kind,
      required: true,
      placeholder: `{{${key}}}`,
    });
  }
  return parameters;
}

function parseMcpDraftSpec(
  rawInstall: unknown,
  fallbackName: string,
  requirements: CapabilityRequirement[],
): CapabilityInstallDraftSpec | null {
  const install = asRecord(rawInstall);
  const mcpServer = asRecord(install.mcpServer);
  if (Object.keys(mcpServer).length === 0) {
    return null;
  }

  const type = asString(mcpServer.type);
  if (type !== 'stdio') {
    return null;
  }

  const name = asString(mcpServer.name) || fallbackName;
  const command = asString(mcpServer.command);
  const args = asStringArray(mcpServer.args);
  if (!isSafeMcpServerName(name) || !command || mcpServer.env !== undefined) {
    return null;
  }
  if (containsTemplatePlaceholder(name) || containsTemplatePlaceholder(command)) {
    return null;
  }

  const config = {
    name,
    type,
    command,
    args,
  };
  const placeholderKeys = extractTemplatePlaceholders(args);
  const parameters = buildDraftParameters(placeholderKeys, requirements);
  if (!parameters) {
    return null;
  }

  return {
    kind: 'mcp_server',
    target: 'project_mcp_json',
    name,
    config,
    ...(parameters.length > 0 ? { parameters } : {}),
  };
}

function requirement(
  kind: CapabilityRequirement['kind'],
  label: string,
  status: CapabilityRequirement['status'],
  value?: string,
  sensitive = false,
): CapabilityRequirement {
  return {
    kind,
    label,
    status,
    ...(value ? { value } : {}),
    ...(sensitive ? { sensitive } : {}),
  };
}

function permission(label: string, level: CapabilityPermission['level'], detail?: string): CapabilityPermission {
  return {
    label,
    level,
    ...(detail ? { detail } : {}),
  };
}

function buildRisk(tier: CapabilityRiskInfo['tier'], reasons: string[], dataTouched?: string[]): CapabilityRiskInfo {
  return {
    tier,
    reasons,
    ...(dataTouched?.length ? { dataTouched } : {}),
  };
}

function parseCuratedRequirement(raw: CuratedRegistryRequirement): CapabilityRequirement | null {
  const label = asString(raw.label);
  if (!label) return null;
  const sensitive = raw.sensitive === true;
  return requirement(
    isRequirementKind(raw.kind) ? raw.kind : 'config',
    label,
    isRequirementStatus(raw.status) ? raw.status : 'unknown',
    sensitive ? undefined : asString(raw.value),
    sensitive,
  );
}

function parseCuratedPermission(raw: CuratedRegistryPermission): CapabilityPermission | null {
  const label = asString(raw.label);
  if (!label) return null;
  return permission(
    label,
    isRiskTier(raw.level) ? raw.level : 'medium',
    asString(raw.detail),
  );
}

function parseCuratedRisk(raw: CuratedRegistryRisk | undefined, kind: CuratedCapabilityKind): CapabilityRiskInfo {
  const tier = isRiskTier(raw?.tier)
    ? raw.tier
    : kind === 'workflow_recipe' ? 'low' : 'medium';
  const reasons = asStringArray(raw?.reasons);
  return buildRisk(
    tier,
    reasons.length > 0 ? reasons : ['本地 curated registry 模板，启用前需要回到对应设置页配置'],
    asStringArray(raw?.dataTouched),
  );
}

function buildInstallPlan(
  kind: CuratedCapabilityKind,
  name: string,
  draft?: CapabilityInstallDraftSpec | null,
  sourceKind: RegistryCapabilitySourceKind = 'curated',
): CapabilityInstallPlan {
  const registrySafety = sourceKind === 'curated'
    ? 'No remote registry fetch.'
    : 'Signed control-plane registry envelope verified before draft generation.';
  switch (kind) {
    case 'mcp_template':
      if (draft) {
        return {
          mode: 'draft_config',
          title: `生成草稿: ${name}`,
          summary: '写入 disabled MCP server 草稿；不会启动进程、不会连接 server、不会启用工具。',
          writes: [
            {
              kind: 'config',
              target: 'project .code-agent/mcp.json',
              action: 'create',
              note: 'Draft is persisted with enabled:false and lazyLoad:true before explicit user enablement.',
            },
          ],
          steps: [
            '校验 server name、transport 和 stdio command。',
            '写入 disabled MCP server draft，并在 MCP 设置中展示。',
            '用户显式启用前不连接、不启动 stdio command。',
          ],
          safety: [
            registrySafety,
            'No package install or command execution during draft install.',
            'Existing MCP permission and approval model remains authoritative.',
          ],
          rollback: [
            'Remove the generated disabled MCP server draft from .code-agent/mcp.json.',
          ],
          draft,
        };
      }
      return {
        mode: 'preview_only',
        title: `安装预览: ${name}`,
        summary: '生成 disabled MCP server 草稿的预览；不会写 mcp.json、不会启动进程、不会连接 server。',
        writes: [
          {
            kind: 'config',
            target: 'project or user mcp.json',
            action: 'create',
            note: 'Draft must use enabled:false and lazyLoad:true before explicit user enablement.',
          },
        ],
        steps: [
          '确认 server name、transport、command/url 和必填配置。',
          '生成 disabled draft，并回到 MCP 设置页由用户检查。',
          '用户显式启用前不连接、不启动 stdio command。',
        ],
        safety: [
          registrySafety,
          'No command execution during preview.',
          'Existing MCP permission and approval model remains authoritative.',
        ],
        rollback: [
          'Remove the generated disabled MCP server draft from mcp.json.',
        ],
      };
    case 'channel_adapter':
      return {
        mode: 'preview_only',
        title: `安装预览: ${name}`,
        summary: '生成 disabled Channel account 草稿的预览；不会写账号、不会打开 ingress、不会保存 secret。',
        writes: [
          {
            kind: 'config',
            target: 'Channels account config',
            action: 'create',
            note: 'Draft must stay disabled until secret, privacy mode, and allowed scope are reviewed.',
          },
        ],
        steps: [
          '确认 channel type、账号名、secret 字段和 privacy mode。',
          '生成 disabled account draft，并回到 Channels 设置页由用户检查。',
          '用户显式启用前不监听 webhook、不接受外部消息。',
        ],
        safety: [
          'No ingress is opened during preview.',
          'No secret value is read from registry metadata.',
          'Existing channel privacy controls remain authoritative.',
        ],
        rollback: [
          'Delete the generated disabled channel account draft.',
        ],
      };
    case 'workflow_recipe':
      return {
        mode: 'preview_only',
        title: `安装预览: ${name}`,
        summary: '生成 disabled local workflow recipe 草稿的预览；不会写 recipe 文件、不会注入上下文。',
        writes: [
          {
            kind: 'file',
            target: '<workspace>/.code-agent/workflows/*.json',
            action: 'create',
            note: 'Draft recipe stays disabled and only references already configured capabilities.',
          },
        ],
        steps: [
          '确认 workflow 输入、输出、依赖能力和隐私边界。',
          '生成 disabled workflow recipe draft，由用户检查。',
          '用户显式启用前不进入 prompt/context 或 automation runtime。',
        ],
        safety: [
          'No workflow execution during preview.',
          'No new tool permission is granted by the recipe.',
          'Recipe may only reference capabilities already visible in Capability Center.',
        ],
        rollback: [
          'Delete the generated disabled workflow recipe draft.',
        ],
      };
  }
}

function parseCuratedRegistryItem(
  raw: CuratedRegistryItem,
  filePath: string,
  fileSource: Record<string, unknown>,
  registryFileHash: string,
  sourceKind: RegistryCapabilitySourceKind,
  idPrefix: string,
  registryTrustBlockReason?: string,
): { item: CapabilityCenterItem | null; diagnostic?: CapabilityCenterDiagnostic } {
  const id = asString(raw.id);
  const kind = raw.kind;
  const name = asString(raw.name);
  const summary = asString(raw.summary);
  const itemId = id || asString(raw.name);
  if (!id) {
    return {
      item: null,
      diagnostic: diagnostic({
        code: 'missing_required_field',
        message: 'Skipped registry item because id is missing.',
        path: filePath,
        itemId,
      }),
    };
  }
  if (!isCuratedKind(kind)) {
    return {
      item: null,
      diagnostic: diagnostic({
        code: 'unsupported_kind',
        message: `Skipped registry item ${id} because kind is not supported by the local curated registry.`,
        path: filePath,
        itemId: id,
      }),
    };
  }
  if (!name || !summary) {
    return {
      item: null,
      diagnostic: diagnostic({
        code: 'missing_required_field',
        message: `Skipped registry item ${id} because name or summary is missing.`,
        path: filePath,
        itemId: id,
      }),
    };
  }

  const source = asRecord(raw.source);
  const audit = asRecord(raw.audit);
  const statusLabel = asString(source.reviewedAt) || asString(fileSource.reviewedAt)
    ? 'reviewed'
    : sourceKind === 'curated' ? 'curated' : 'trusted remote';
  const config = Array.isArray(raw.config)
    ? raw.config.map((entry) => parseCuratedRequirement(asRecord(entry))).filter((entry): entry is CapabilityRequirement => Boolean(entry))
    : [];
  const dependencies = Array.isArray(raw.dependencies)
    ? raw.dependencies.map((entry) => parseCuratedRequirement(asRecord(entry))).filter((entry): entry is CapabilityRequirement => Boolean(entry))
    : [];
  const permissions = Array.isArray(raw.permissions)
    ? raw.permissions.map((entry) => parseCuratedPermission(asRecord(entry))).filter((entry): entry is CapabilityPermission => Boolean(entry))
    : [];
  const draft = kind === 'mcp_template'
    ? parseMcpDraftSpec(raw.install, id, [...config, ...dependencies])
    : null;
  const trustBlockedDraft = Boolean(draft && registryTrustBlockReason);
  const runtime = trustBlockedDraft ? 'blocked' : 'not_configured';
  const installActionReason = trustBlockedDraft
    ? registryTrustBlockReason
    : draft
      ? '可生成 disabled MCP server 草稿'
      : kind === 'channel_adapter'
      ? '请在 Channels 设置中添加账号'
      : kind === 'mcp_template'
        ? '请在 MCP 设置中添加 server'
        : 'Workflow recipe 模板只读展示';

  return {
    item: {
      id: encodeCapabilityId(idPrefix, `${kind}:${id}`),
      kind,
      name,
      summary,
      description: asString(raw.description),
      tags: unique([sourceKind, kind, ...asStringArray(raw.tags)]),
      source: {
        kind: sourceKind,
        label: asString(source.label) || asString(fileSource.label) || sourceLabel(sourceKind),
        path: filePath,
        url: asString(source.url),
        version: asString(source.version) || asString(fileSource.version),
        author: asString(source.author) || asString(fileSource.author),
        reviewedAt: asString(source.reviewedAt) || asString(fileSource.reviewedAt),
        expiresAt: asString(source.expiresAt) || asString(fileSource.expiresAt),
        signedAt: asString(source.signedAt) || asString(fileSource.signedAt),
        keyId: asString(source.keyId) || asString(fileSource.keyId),
        signature: asString(source.signature) || asString(fileSource.signature),
        contentHash: asString(source.contentHash) || asString(fileSource.contentHash),
        registryFileHash,
      },
      state: {
        install: 'available',
        enable: 'not_applicable',
        runtime,
        mount: 'not_applicable',
        statusLabel: trustBlockedDraft ? 'trust blocked' : statusLabel,
      },
      risk: parseCuratedRisk(asRecord(raw.risk), kind),
      permissions: permissions.length > 0
        ? permissions
        : [permission('Configuration required', 'medium', '模板只展示用途和配置要求，不写入运行时配置')],
      config,
      dependencies,
      audit: {
        configFiles: [filePath],
        notes: [
          ...asStringArray(audit.notes),
          ...(trustBlockedDraft && registryTrustBlockReason ? [registryTrustBlockReason] : []),
          draft
            ? 'Capability registry 模板只能生成禁用草稿，不启用、不连接。'
            : 'Capability registry 模板只读展示，不安装、不写配置、不连接。',
        ],
      },
      actions: {
        canEnable: false,
        canDisable: false,
        canInstallDraft: Boolean(draft && !trustBlockedDraft),
        reason: installActionReason,
      },
      installPlan: buildInstallPlan(kind, name, draft, sourceKind),
    },
  };
}

export function parseCapabilityRegistryPayload(
  parsed: CuratedRegistryFile,
  options: ParseCapabilityRegistryPayloadOptions,
): CuratedRegistryReadResult {
  const source = {
    ...asRecord(parsed.source),
    ...(asString(parsed.version) ? { version: asString(parsed.version) } : {}),
    ...options.sourceTrust,
  };
  const diagnostics: CapabilityCenterDiagnostic[] = [];
  const items: CapabilityCenterItem[] = [];

  if (!Array.isArray(parsed.items)) {
    return {
      items,
      diagnostics: [diagnostic({
        code: 'invalid_registry_items',
        message: 'Skipped capability registry file because items is missing or is not an array.',
        path: options.sourcePath,
        severity: 'error',
      })],
    };
  }

  const rawItems = parsed.items;
  const revoked = parseRevokedIds(parsed.revokedIds, options.sourcePath);
  diagnostics.push(...revoked.diagnostics);
  const requiresRegistryTrust = options.trustMode === 'source_metadata'
    && rawItems.some((rawItem) => hasMcpDraftCandidate(asRecord(rawItem)));
  const trustDiagnostics = options.trustMode === 'source_metadata'
    ? [
      ...buildContentHashDiagnostics(options.sourcePath, asString(source.contentHash), options.registryFileHash, requiresRegistryTrust),
      ...buildExpiresAtDiagnostics(options.sourcePath, asString(source.expiresAt), requiresRegistryTrust),
    ]
    : [];
  diagnostics.push(...trustDiagnostics);

  const registryTrustBlockReason = buildTrustBlockReason(trustDiagnostics);
  for (const rawItem of rawItems) {
    const rawRecord = asRecord(rawItem);
    const revokedId = isRevokedRegistryItem(rawRecord, revoked.revokedIds);
    if (revokedId) {
      diagnostics.push(diagnostic({
        code: 'revoked_registry_item',
        message: `Skipped registry item ${revokedId} because it is listed in revokedIds.`,
        path: options.sourcePath,
        itemId: revokedId,
        severity: 'warning',
        blocking: true,
      }));
      continue;
    }

    const { item, diagnostic: itemDiagnostic } = parseCuratedRegistryItem(
      rawRecord,
      options.sourcePath,
      source,
      options.registryFileHash,
      options.sourceKind,
      options.idPrefix,
      registryTrustBlockReason,
    );
    if (itemDiagnostic) {
      diagnostics.push(itemDiagnostic);
    }
    if (item) {
      items.push(item);
    }
  }

  return { items, diagnostics };
}

async function readCuratedRegistryDir(dir: string): Promise<CuratedRegistryReadResult> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.debug('Failed to read capability registry dir', { dir, error });
      return {
        items: [],
        diagnostics: [diagnostic({
          code: 'unreadable_registry_dir',
          message: 'Skipped capability registry directory because it could not be read.',
          path: dir,
          severity: 'error',
        })],
      };
    }
    return { items: [], diagnostics: [] };
  }

  const items: CapabilityCenterItem[] = [];
  const diagnostics: CapabilityCenterDiagnostic[] = [];
  for (const filename of entries.filter((entry) => entry.endsWith('.json') && !entry.endsWith('.schema.json'))) {
    const fullPath = path.join(dir, filename);
    try {
      const parsed = JSON.parse(await fs.readFile(fullPath, 'utf8')) as CuratedRegistryFile;
      const registryFileHash = buildRegistryFileHash(parsed);
      const result = parseCapabilityRegistryPayload(parsed, {
        sourcePath: fullPath,
        sourceKind: 'curated',
        idPrefix: 'curated',
        registryFileHash,
        trustMode: 'source_metadata',
      });
      items.push(...result.items);
      diagnostics.push(...result.diagnostics);
    } catch (error) {
      logger.debug('Skipping invalid capability registry file', { filePath: fullPath, error });
      diagnostics.push(diagnostic({
        code: 'invalid_registry_json',
        message: 'Skipped capability registry file because it is not valid JSON.',
        path: fullPath,
        severity: 'error',
      }));
    }
  }
  return { items, diagnostics };
}

export async function readCuratedRegistry(workingDirectory?: string): Promise<CuratedRegistryReadResult> {
  const dirs = unique([
    path.join(process.cwd(), 'docs', 'capabilities'),
    workingDirectory ? path.join(workingDirectory, '.code-agent', 'capabilities') : undefined,
  ]);
  const groups = await Promise.all(dirs.map((dir) => readCuratedRegistryDir(dir)));
  const items: CapabilityCenterItem[] = [];
  const diagnostics: CapabilityCenterDiagnostic[] = [];
  const seen = new Set<string>();

  for (const group of groups) {
    diagnostics.push(...group.diagnostics);
    for (const item of group.items) {
      if (seen.has(item.id)) {
        diagnostics.push(diagnostic({
          code: 'duplicate_registry_item',
          message: `Skipped duplicate registry item ${item.id}; the first definition wins.`,
          path: item.source.path,
          itemId: item.id,
        }));
        continue;
      }
      seen.add(item.id);
      items.push(item);
    }
  }

  return { items, diagnostics };
}
