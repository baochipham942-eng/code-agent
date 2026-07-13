// ============================================================================
// Official Skill Registry（远程 skill marketplace）
// 控制面签名下发的收录条目；安装走 marketplace installService 的钉 SHA 链路。
// 收录流水线（scripts/skill-registry-pin.mjs）在收录时计算 pinnedCommit/contentHash，
// 客户端安装时强校验，不符 fail-closed。
// ============================================================================

export type SkillRegistryRiskTier = 'low' | 'medium' | 'high';

export interface SkillRegistryRisk {
  tier: SkillRegistryRiskTier;
  /** 风险提示（面向用户的中文短句） */
  reasons?: string[];
}

export interface SkillRegistryEntry {
  /** 唯一名，同 marketplace PluginEntry.name 语义 */
  name: string;
  /** 中文显示名 */
  displayName?: string;
  description?: string;
  /** GitHub 仓库（owner/repo 或 https://github.com/owner/repo） */
  repository: string;
  /** 仓库内子路径（相对仓库根） */
  path?: string;
  /** 收录时钉死的 40 位 commit SHA；客户端只按此 SHA 下载，永不追分支头 */
  pinnedCommit: string;
  /** 收录时对该 SHA 的 codeload zip 计算的 sha256（hex）；安装时强校验 */
  contentHash: string;
  /** skill 目录列表（相对 path） */
  skills: string[];
  /** prompt command 文件列表（相对 path） */
  commands?: string[];
  /** 发布方（官方收录制下 = 收录方） */
  publisher: string;
  /** 收录审核日期（ISO） */
  reviewedAt: string;
  version?: string;
  tags?: string[];
  risk?: SkillRegistryRisk;
}

export interface SkillRegistryPayload {
  schemaVersion: 1;
  updatedAt?: string;
  entries: SkillRegistryEntry[];
}

/** registry 来源安装在 InstalledPluginRecord.marketplace 里的固定标识 */
export const SKILL_REGISTRY_MARKETPLACE_ID = 'official-registry';

/** 渲染层货架条目：registry 条目 + 本机安装/升级状态（host 侧计算） */
export interface SkillRegistryListItem {
  entry: SkillRegistryEntry;
  /** 本机已装该条目时的钉点 */
  installedPinnedCommit?: string;
  installed: boolean;
  /** installed 且 registry 钉点 ≠ 本机钉点 */
  hasUpdate: boolean;
}
