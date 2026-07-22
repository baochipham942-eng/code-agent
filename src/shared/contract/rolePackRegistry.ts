// ============================================================================
// Official Role Pack Registry（远程角色包货架）
// ============================================================================

import type { BuiltinRoleVisual } from './roleAssets';
import type { SkillRegistryEntry } from './skillRegistry';

/** 指向 skill_registry 内条目名的角色包 skill 引用。 */
export interface RolePackSkillRef {
  registryName: string;
}

/** 由控制面签名下发的角色包条目。 */
export interface RolePackEntry {
  roleId: string;
  displayName?: string;
  description?: string;
  agentMd: string;
  visual: BuiltinRoleVisual;
  skills: RolePackSkillRef[];
  packVersion: string;
  minAppVersion?: string;
  publisher: string;
  reviewedAt: string;
  tags?: string[];
  risk?: SkillRegistryEntry['risk'];
}

/** registry 来源角色包在本地安装记录中的固定标识。 */
export const ROLE_PACK_MARKETPLACE_ID = 'official-role-pack';
