// ============================================================================
// skillInstallCaution - SKILL_CAUTION_CONFIRMATION_REQUIRED 判别（renderer 侧）
// ============================================================================
// host 装载扫描的 caution 门在未签名来源上不直接装，而是把这个契约整包返回
// （src/shared/contract/skillInstallCaution.ts）。安装通道的返回值因此是
// 「普通结果 | 确认要求」的联合，各调用页用本判别分流。
// 放 services 层：skillLocalZip（service）与设置页（component）都要用，
// 方向只能是 component → service，不能反过来。

import type { SkillCautionConfirmationRequired } from '@shared/contract/skillInstallCaution';

/** 安装结果是否为「caution 待确认」（未安装，等用户确认后携 token 重发） */
export function isSkillCautionConfirmationRequired(
  value: unknown,
): value is SkillCautionConfirmationRequired {
  return (
    typeof value === 'object'
    && value !== null
    && (value as { success?: unknown }).success === false
    && (value as { code?: unknown }).code === 'SKILL_CAUTION_CONFIRMATION_REQUIRED'
  );
}
