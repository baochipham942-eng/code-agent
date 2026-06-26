import type { DirectionTokens } from '../../design/direction-tokens';
import { DESIGN_ACCEPTANCE_CONTRACT } from '../constants/designAcceptanceContract';
import { REGION_LOCK } from '../constants/designWorkspace';
import {
  brandContractToBriefProjection,
  type BrandBriefProjection,
  type BrandContract,
} from './brandContract';
import { normalizeDirectionTokens, normalizeStringList } from './designBrief';

export const DESIGN_ACCEPTANCE_CONTRACT_INTENT = 'agent_convergence' as const;

export type DesignAcceptanceContractSource =
  | 'manual'
  | 'design_brief'
  | 'qa'
  | 'handoff'
  | 'inferred';

export type DesignAcceptanceCriterionPriority = 'must' | 'should' | 'nice_to_have';
export type DesignAcceptanceCriterionSource =
  | 'user'
  | 'design_brief'
  | 'qa'
  | 'handoff'
  | 'inferred';

export type DesignLockedRegionPreserve = 'layout' | 'content' | 'visual' | 'interaction';
export type DesignLockedRegionMode = 'best_effort' | 'strict';
export type DesignAcceptanceBrandRefSource = 'active_brand' | 'design_brief' | 'manual' | 'reference';

export interface DesignRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesignAcceptanceCriterion {
  id: string;
  text: string;
  priority: DesignAcceptanceCriterionPriority;
  source?: DesignAcceptanceCriterionSource;
}

export interface DesignLockedRegion {
  id: string;
  nodeId?: string;
  label?: string;
  reason?: string;
  bounds?: DesignRect;
  preserve: DesignLockedRegionPreserve[];
  lockMode: DesignLockedRegionMode;
  regionLock: {
    epsilon: number;
    strict: boolean;
  };
  source?: DesignAcceptanceContractSource;
}

export interface DesignAcceptanceBrandRef {
  id?: string;
  name?: string;
  source: DesignAcceptanceBrandRefSource;
  tokens?: DirectionTokens;
  contract?: BrandBriefProjection;
  logoPath?: string;
  notes?: string[];
}

export interface DesignAcceptanceContract {
  version: typeof DESIGN_ACCEPTANCE_CONTRACT.VERSION;
  intent: typeof DESIGN_ACCEPTANCE_CONTRACT_INTENT;
  source?: DesignAcceptanceContractSource;
  acceptanceCriteria: DesignAcceptanceCriterion[];
  lockedRegions: DesignLockedRegion[];
  brandRefs: DesignAcceptanceBrandRef[];
  notes?: string[];
}

function normalizeText(value: unknown, max: number = DESIGN_ACCEPTANCE_CONTRACT.MAX_TEXT_CHARS): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

function normalizeId(value: unknown, fallback: string): string {
  return normalizeText(value, DESIGN_ACCEPTANCE_CONTRACT.MAX_ID_CHARS) ?? fallback;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeRect(value: unknown): DesignRect | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Partial<DesignRect>;
  if (!isFiniteNumber(raw.x) || !isFiniteNumber(raw.y) || !isFiniteNumber(raw.width) || !isFiniteNumber(raw.height)) {
    return undefined;
  }
  if (raw.width <= 0 || raw.height <= 0) return undefined;
  return {
    x: raw.x,
    y: raw.y,
    width: raw.width,
    height: raw.height,
  };
}

function normalizeSource(value: unknown): DesignAcceptanceContractSource | undefined {
  return value === 'manual'
    || value === 'design_brief'
    || value === 'qa'
    || value === 'handoff'
    || value === 'inferred'
    ? value
    : undefined;
}

function normalizeCriterionPriority(value: unknown): DesignAcceptanceCriterionPriority {
  return value === 'should' || value === 'nice_to_have' ? value : 'must';
}

function normalizeCriterionSource(value: unknown): DesignAcceptanceCriterionSource | undefined {
  return value === 'user'
    || value === 'design_brief'
    || value === 'qa'
    || value === 'handoff'
    || value === 'inferred'
    ? value
    : undefined;
}

function normalizeCriterion(value: unknown, index: number): DesignAcceptanceCriterion | undefined {
  if (typeof value === 'string') {
    const text = normalizeText(value);
    if (!text) return undefined;
    return {
      id: `acceptance-${index + 1}`,
      text,
      priority: 'must',
      source: 'user',
    };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Partial<DesignAcceptanceCriterion>;
  const text = normalizeText(raw.text);
  if (!text) return undefined;
  const criterion: DesignAcceptanceCriterion = {
    id: normalizeId(raw.id, `acceptance-${index + 1}`),
    text,
    priority: normalizeCriterionPriority(raw.priority),
  };
  const source = normalizeCriterionSource(raw.source);
  if (source) criterion.source = source;
  return criterion;
}

function normalizePreserveList(value: unknown): DesignLockedRegionPreserve[] {
  const raw = Array.isArray(value) ? value : [value];
  const preserve = raw.filter((item): item is DesignLockedRegionPreserve =>
    item === 'layout'
    || item === 'content'
    || item === 'visual'
    || item === 'interaction',
  );
  return preserve.length > 0 ? Array.from(new Set(preserve)) : ['visual'];
}

function normalizeRegionLock(value: unknown, mode: DesignLockedRegionMode): DesignLockedRegion['regionLock'] {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<DesignLockedRegion['regionLock']>
    : {};
  const epsilon = isFiniteNumber(raw.epsilon) && raw.epsilon >= 0 ? raw.epsilon : REGION_LOCK.EPSILON;
  const strict = typeof raw.strict === 'boolean' ? raw.strict : (mode === 'strict' || REGION_LOCK.STRICT_DEFAULT);
  return { epsilon, strict };
}

function normalizeLockedRegion(value: unknown, index: number): DesignLockedRegion | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Partial<DesignLockedRegion> & { rect?: DesignRect };
  const nodeId = normalizeText(raw.nodeId, DESIGN_ACCEPTANCE_CONTRACT.MAX_ID_CHARS);
  const bounds = normalizeRect(raw.bounds) ?? normalizeRect(raw.rect);
  if (!nodeId && !bounds) return undefined;

  const lockMode: DesignLockedRegionMode = raw.lockMode === 'strict' ? 'strict' : 'best_effort';
  const region: DesignLockedRegion = {
    id: normalizeId(raw.id, nodeId ?? `locked-region-${index + 1}`),
    preserve: normalizePreserveList(raw.preserve),
    lockMode,
    regionLock: normalizeRegionLock(raw.regionLock, lockMode),
  };
  if (nodeId) region.nodeId = nodeId;
  const label = normalizeText(raw.label);
  if (label) region.label = label;
  const reason = normalizeText(raw.reason);
  if (reason) region.reason = reason;
  if (bounds) region.bounds = bounds;
  const source = normalizeSource(raw.source);
  if (source) region.source = source;
  return region;
}

function normalizeBriefProjection(value: unknown): BrandBriefProjection | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Partial<BrandBriefProjection>;
  const keep = normalizeStringList(raw.keep) ?? [];
  const change = normalizeStringList(raw.change) ?? [];
  const doNotCopy = normalizeStringList(raw.doNotCopy) ?? [];
  const logoPath = normalizeText(raw.logoPath);
  if (keep.length === 0 && change.length === 0 && doNotCopy.length === 0 && !logoPath) {
    return undefined;
  }
  const projection: BrandBriefProjection = { keep, change, doNotCopy };
  if (logoPath) projection.logoPath = logoPath;
  return projection;
}

function normalizeBrandRefSource(value: unknown): DesignAcceptanceBrandRefSource {
  return value === 'active_brand'
    || value === 'design_brief'
    || value === 'reference'
    ? value
    : 'manual';
}

function normalizeBrandRef(value: unknown): DesignAcceptanceBrandRef | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Partial<DesignAcceptanceBrandRef> & Partial<BrandContract>;
  const id = normalizeText(raw.id, DESIGN_ACCEPTANCE_CONTRACT.MAX_ID_CHARS);
  const name = normalizeText(raw.name);
  const tokens = normalizeDirectionTokens(raw.tokens);
  const contract = normalizeBriefProjection(raw.contract)
    ?? normalizeBriefProjection({
      keep: raw.keep,
      change: raw.change,
      doNotCopy: raw.doNotCopy,
      logoPath: raw.logoPath,
    });
  const logoPath = normalizeText(raw.logoPath);
  const notes = normalizeStringList(raw.notes)?.slice(0, DESIGN_ACCEPTANCE_CONTRACT.MAX_NOTES);

  if (!id && !name && !tokens && !contract && !logoPath && !notes?.length) {
    return undefined;
  }

  const ref: DesignAcceptanceBrandRef = {
    source: normalizeBrandRefSource(raw.source),
  };
  if (id) ref.id = id;
  if (name) ref.name = name;
  if (tokens) ref.tokens = tokens;
  if (contract) ref.contract = contract;
  if (logoPath) ref.logoPath = logoPath;
  if (notes?.length) ref.notes = notes;
  return ref;
}

function normalizeList<T>(
  value: unknown,
  limit: number,
  normalize: (item: unknown, index: number) => T | undefined,
  identity: (item: T) => string,
): T[] {
  if (!Array.isArray(value)) return [];
  const items: T[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    const normalized = normalize(item, index);
    if (!normalized) continue;
    const key = identity(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(normalized);
    if (items.length >= limit) break;
  }
  return items;
}

export function designAcceptanceBrandRefFromBrandContract(
  brand: BrandContract,
  source: DesignAcceptanceBrandRefSource = 'active_brand',
): DesignAcceptanceBrandRef {
  const ref: DesignAcceptanceBrandRef = {
    id: brand.id,
    name: brand.name,
    source,
    tokens: brand.tokens,
    contract: brandContractToBriefProjection(brand),
  };
  if (brand.logoPath) ref.logoPath = brand.logoPath;
  return ref;
}

export function designAcceptanceCriteriaFromConstraints(
  constraints: string[] | undefined,
): DesignAcceptanceCriterion[] {
  return (normalizeStringList(constraints) ?? []).map((text, index) => ({
    id: `constraint-${index + 1}`,
    text,
    priority: 'must',
    source: 'design_brief',
  }));
}

export function normalizeDesignAcceptanceContract(
  value?: unknown,
): DesignAcceptanceContract | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Partial<DesignAcceptanceContract>;

  const acceptanceCriteria = normalizeList(
    raw.acceptanceCriteria,
    DESIGN_ACCEPTANCE_CONTRACT.MAX_ACCEPTANCE_CRITERIA,
    normalizeCriterion,
    (item) => item.text,
  );
  const lockedRegions = normalizeList(
    raw.lockedRegions,
    DESIGN_ACCEPTANCE_CONTRACT.MAX_LOCKED_REGIONS,
    normalizeLockedRegion,
    (item) => item.nodeId ?? `${item.bounds?.x},${item.bounds?.y},${item.bounds?.width},${item.bounds?.height}`,
  );
  const brandRefs = normalizeList(
    raw.brandRefs,
    DESIGN_ACCEPTANCE_CONTRACT.MAX_BRAND_REFS,
    (item) => normalizeBrandRef(item),
    (item) => item.id ?? item.name ?? JSON.stringify(item.contract ?? item.tokens ?? item.notes),
  );
  const notes = normalizeStringList(raw.notes)?.slice(0, DESIGN_ACCEPTANCE_CONTRACT.MAX_NOTES);
  const source = normalizeSource(raw.source);

  if (acceptanceCriteria.length === 0 && lockedRegions.length === 0 && brandRefs.length === 0 && !notes?.length) {
    return undefined;
  }

  const contract: DesignAcceptanceContract = {
    version: DESIGN_ACCEPTANCE_CONTRACT.VERSION,
    intent: DESIGN_ACCEPTANCE_CONTRACT_INTENT,
    acceptanceCriteria,
    lockedRegions,
    brandRefs,
  };
  if (source) contract.source = source;
  if (notes?.length) contract.notes = notes;
  return contract;
}

export function serializeDesignAcceptanceContract(value: unknown): string | undefined {
  const normalized = normalizeDesignAcceptanceContract(value);
  return normalized ? JSON.stringify(normalized) : undefined;
}

export function deserializeDesignAcceptanceContract(value: string): DesignAcceptanceContract | undefined {
  try {
    const parsed = JSON.parse(value);
    return normalizeDesignAcceptanceContract(parsed);
  } catch {
    return undefined;
  }
}

export function formatDesignAcceptanceContractForPrompt(
  value?: unknown,
): string | null {
  const normalized = normalizeDesignAcceptanceContract(value);
  return normalized ? JSON.stringify(normalized, null, 2) : null;
}
