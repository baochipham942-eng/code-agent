// ============================================================================
// Remote signed skill registry reader（官方 Skill Marketplace 货架）
// 形状对齐 remoteCapabilityRegistryService：签名信封校验 + 失败即空货架。
// 安装动作只认 host 侧新鲜拉取的条目（renderer 只传 name），杜绝渲染层伪造条目。
// ============================================================================

import { z } from 'zod';
import { CLOUD, CLOUD_ENDPOINTS } from '../../../shared/constants';
import type {
  SkillRegistryEntry,
  SkillRegistryListItem,
} from '../../../shared/contract/skillRegistry';
import { SKILL_REGISTRY_MARKETPLACE_ID } from '../../../shared/contract/skillRegistry';
import {
  getControlPlanePublicKeysFromEnv,
  isControlPlaneEnvelope,
  verifyControlPlaneEnvelope,
  type ControlPlanePublicKeys,
} from '../../services/cloud/controlPlaneTrust';
import { createLogger } from '../../services/infra/logger';
import { listInstalledPlugins } from './installService';

const logger = createLogger('RemoteSkillRegistryService');

const SkillRegistryEntrySchema = z.object({
  name: z.string().min(1),
  displayName: z.string().optional(),
  description: z.string().optional(),
  repository: z.string().min(3),
  path: z.string().optional(),
  pinnedCommit: z.string().regex(/^[0-9a-f]{40}$/i),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/i),
  skills: z.array(z.string().min(1)).min(1),
  commands: z.array(z.string()).optional(),
  publisher: z.string().min(1),
  reviewedAt: z.string().min(1),
  version: z.string().optional(),
  tags: z.array(z.string()).optional(),
  keywords: z.array(z.string()).optional(),
  domains: z.array(z.string()).optional(),
  risk: z.object({
    tier: z.enum(['low', 'medium', 'high']),
    reasons: z.array(z.string()).optional(),
  }).optional(),
});

const SkillRegistryPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  updatedAt: z.string().optional(),
  entries: z.array(z.unknown()),
});

export interface SkillRegistryFetchResult {
  entries: SkillRegistryEntry[];
  /** 空货架时的原因码（面向诊断，不面向用户文案） */
  error?: string;
}

export interface RemoteSkillRegistryServiceOptions {
  controlPlanePublicKeys?: ControlPlanePublicKeys;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  now?: number;
}

export class RemoteSkillRegistryService {
  private options: RemoteSkillRegistryServiceOptions;
  private listItemsCache: { at: number; items: SkillRegistryListItem[] } | null = null;

  constructor(options: RemoteSkillRegistryServiceOptions = {}) {
    this.options = options;
  }

  setOptions(options: RemoteSkillRegistryServiceOptions): void {
    this.options = { ...this.options, ...options };
  }

  async fetchEntries(): Promise<SkillRegistryFetchResult> {
    const publicKeys = this.options.controlPlanePublicKeys || getControlPlanePublicKeysFromEnv();
    if (Object.keys(publicKeys).length === 0) {
      return { entries: [], error: 'public_keys_missing' };
    }

    const endpoint = this.options.endpoint || CLOUD_ENDPOINTS.skillRegistry;
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
        kind: 'skill_registry',
        publicKeys,
        requireSignature: true,
        now: this.options.now,
      });
      if (!trust.trusted || !trust.payload) {
        logger.warn('Rejected untrusted skill registry', { diagnostics: trust.diagnostics });
        return { entries: [], error: 'untrusted_envelope' };
      }

      const payload = SkillRegistryPayloadSchema.safeParse(trust.payload);
      if (!payload.success) {
        return { entries: [], error: 'invalid_payload' };
      }

      const entries: SkillRegistryEntry[] = [];
      for (const raw of payload.data.entries) {
        const parsed = SkillRegistryEntrySchema.safeParse(raw);
        if (parsed.success) {
          entries.push(parsed.data);
        } else {
          // 单条畸形不拖垮整张货架，但要留痕
          logger.warn('Dropped invalid skill registry entry', {
            issues: parsed.error.issues.map((issue) => issue.message).join('; '),
          });
        }
      }
      return { entries };
    } catch (error) {
      logger.warn('Failed to fetch skill registry', { endpoint, error: String(error) });
      return { entries: [], error: 'fetch_failed' };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  /** 货架列表 = registry 条目 × 本机安装状态（registry 为版本源，钉点不一致即有新版） */
  async listItems(): Promise<{ items: SkillRegistryListItem[]; error?: string }> {
    const { entries, error } = await this.fetchEntries();
    if (entries.length === 0) {
      return { items: [], ...(error ? { error } : {}) };
    }
    const installed = await listInstalledPlugins();
    const items = entries.map((entry) => {
      const record = installed[`${entry.name}@${SKILL_REGISTRY_MARKETPLACE_ID}`];
      return {
        entry,
        installed: Boolean(record),
        ...(record?.pinnedCommit ? { installedPinnedCommit: record.pinnedCommit } : {}),
        hasUpdate: Boolean(record) && record?.pinnedCommit !== entry.pinnedCommit,
      };
    });
    return { items };
  }

  /**
   * listItems 的 TTL 缓存版，供输入期推荐等高频只读路径用。
   * 推荐按防抖击键触发，registry 变化极低频——不缓存会让每次输入都打一次控制面网络请求。
   * 安装/货架页仍走 listItems/getEntry 拿新鲜数据。
   */
  async listItemsCached(): Promise<SkillRegistryListItem[]> {
    const now = Date.now();
    if (this.listItemsCache && now - this.listItemsCache.at < CLOUD.REGISTRY_CACHE_TTL) {
      return this.listItemsCache.items;
    }
    const { items } = await this.listItems();
    // 拉取失败/空货架不缓存，下次重试
    if (items.length > 0) {
      this.listItemsCache = { at: now, items };
    }
    return items;
  }

  /** 安装成功后 installed 标记变化，缓存失效 */
  invalidateListCache(): void {
    this.listItemsCache = null;
  }

  /** 按名取 host 侧新鲜条目（安装/升级入口，不信任 renderer 传来的条目体） */
  async getEntry(name: string): Promise<SkillRegistryEntry | null> {
    const { entries } = await this.fetchEntries();
    return entries.find((entry) => entry.name === name) ?? null;
  }
}

let instance: RemoteSkillRegistryService | null = null;

export function getRemoteSkillRegistryService(): RemoteSkillRegistryService {
  if (!instance) {
    instance = new RemoteSkillRegistryService();
  }
  return instance;
}
