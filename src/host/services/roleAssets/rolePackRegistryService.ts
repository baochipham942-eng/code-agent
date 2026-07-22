// ============================================================================
// Remote signed role pack registry reader（官方 Role Pack 货架）
// ============================================================================

import { z } from 'zod';
import { CLOUD, CLOUD_ENDPOINTS } from '../../../shared/constants';
import { SKILL_CATEGORIES } from '../../../shared/constants/skillCatalog';
import type { RolePackEntry } from '../../../shared/contract/rolePackRegistry';
import type { SkillCategory } from '../../../shared/contract/skillRepository';
import { getAppVersion } from '../../platform';
import { compareUpdateVersions } from '../cloud/updateService';
import {
  getControlPlanePublicKeysFromEnv,
  isControlPlaneEnvelope,
  verifyControlPlaneEnvelope,
  type ControlPlanePublicKeys,
} from '../cloud/controlPlaneTrust';
import { createLogger } from '../infra/logger';

const logger = createLogger('RolePackRegistryService');

function getSkillCategoryIds(): [SkillCategory, ...SkillCategory[]] {
  const [firstCategory, ...remainingCategories] = SKILL_CATEGORIES;
  if (!firstCategory) {
    throw new Error('SKILL_CATEGORIES must include at least one category');
  }
  return [firstCategory.id, ...remainingCategories.map((category) => category.id)];
}

const RolePackEntrySchema = z.object({
  roleId: z.string().min(1),
  displayName: z.string().optional(),
  description: z.string().optional(),
  agentMd: z.string().min(1),
  visual: z.object({
    icon: z.string().min(1),
    category: z.enum(getSkillCategoryIds()),
    displayName: z.string().min(1),
    profession: z.string().min(1),
    tags: z.array(z.string()),
    quickPrompts: z.array(z.string()),
  }),
  skills: z.array(z.object({ registryName: z.string().min(1) })),
  packVersion: z.string().min(1),
  minAppVersion: z.string().min(1).optional(),
  publisher: z.string().min(1),
  reviewedAt: z.string().min(1),
  tags: z.array(z.string()).optional(),
  risk: z.object({
    tier: z.enum(['low', 'medium', 'high']),
    reasons: z.array(z.string()).optional(),
  }).optional(),
});

const RolePackRegistryPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  updatedAt: z.string().optional(),
  entries: z.array(z.unknown()),
});

interface RolePackRegistryFetchResult {
  entries: RolePackEntry[];
  /** 空货架时的原因码（面向诊断，不面向用户文案） */
  error?: string;
}

interface RolePackRegistryServiceOptions {
  controlPlanePublicKeys?: ControlPlanePublicKeys;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  now?: number;
  appVersion?: string;
}

class RolePackRegistryService {
  private options: RolePackRegistryServiceOptions;
  private entriesCache: { at: number; entries: RolePackEntry[] } | null = null;

  constructor(options: RolePackRegistryServiceOptions = {}) {
    this.options = options;
  }

  setOptions(options: RolePackRegistryServiceOptions): void {
    this.options = { ...this.options, ...options };
  }

  async fetchEntries(): Promise<RolePackRegistryFetchResult> {
    const publicKeys = this.options.controlPlanePublicKeys || getControlPlanePublicKeysFromEnv();
    if (Object.keys(publicKeys).length === 0) {
      return { entries: [], error: 'public_keys_missing' };
    }

    const endpoint = this.options.endpoint || CLOUD_ENDPOINTS.roleRegistry;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), CLOUD.FETCH_TIMEOUT);
      const response = await (this.options.fetchImpl || fetch)(endpoint, {
        signal: controller.signal,
      });
      if (!response.ok) {
        return { entries: [], error: `http_${response.status}` };
      }

      const value: unknown = await response.json();
      if (!isControlPlaneEnvelope(value)) {
        return { entries: [], error: 'invalid_envelope' };
      }

      const trust = verifyControlPlaneEnvelope<unknown>(value, {
        kind: 'role_registry',
        publicKeys,
        requireSignature: true,
        now: this.options.now,
      });
      if (!trust.trusted || !trust.payload) {
        logger.warn('Rejected untrusted role pack registry', { diagnostics: trust.diagnostics });
        return { entries: [], error: 'untrusted_envelope' };
      }

      const payload = RolePackRegistryPayloadSchema.safeParse(trust.payload);
      if (!payload.success) {
        return { entries: [], error: 'invalid_payload' };
      }

      const appVersion = this.options.appVersion || getAppVersion();
      const entries: RolePackEntry[] = [];
      for (const raw of payload.data.entries) {
        const parsed = RolePackEntrySchema.safeParse(raw);
        if (!parsed.success) {
          logger.warn('Dropped invalid role pack registry entry', {
            issues: parsed.error.issues.map((issue) => issue.message).join('; '),
          });
          continue;
        }
        if (
          parsed.data.minAppVersion
          && compareUpdateVersions(parsed.data.minAppVersion, appVersion) > 0
        ) {
          logger.warn('Dropped incompatible role pack registry entry', {
            roleId: parsed.data.roleId,
            minAppVersion: parsed.data.minAppVersion,
            appVersion,
          });
          continue;
        }
        entries.push(parsed.data);
      }
      return { entries };
    } catch (error) {
      logger.warn('Failed to fetch role pack registry', { endpoint, error: String(error) });
      return { entries: [], error: 'fetch_failed' };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  /** 供高频只读路径使用；失败或空货架不缓存，避免延长控制面故障。 */
  async fetchEntriesCached(): Promise<RolePackEntry[]> {
    const now = Date.now();
    if (this.entriesCache && now - this.entriesCache.at < CLOUD.REGISTRY_CACHE_TTL) {
      return this.entriesCache.entries;
    }
    const { entries } = await this.fetchEntries();
    if (entries.length > 0) {
      this.entriesCache = { at: now, entries };
    }
    return entries;
  }

  invalidateEntriesCache(): void {
    this.entriesCache = null;
  }

  async getEntry(roleId: string): Promise<RolePackEntry | null> {
    const { entries } = await this.fetchEntries();
    return entries.find((entry) => entry.roleId === roleId) ?? null;
  }
}

let instance: RolePackRegistryService | null = null;

export function getRolePackRegistryService(): RolePackRegistryService {
  if (!instance) {
    instance = new RolePackRegistryService();
  }
  return instance;
}
