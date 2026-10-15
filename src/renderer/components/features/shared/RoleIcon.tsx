// ============================================================================
// RoleIcon - 角色视觉化图标渲染（P2-1）
// ============================================================================
//
// 角色的 icon 字段是 lucide 图标名字符串（curated 子集，见 builtinRoles.ts）。
// 这里按名映射到 lucide 组件渲染；缺省/未知名兜底 UserCircle。
// 预设角色配死 icon，用户自建角色无 icon → 兜底默认头像。
// ============================================================================

import React from 'react';
import {
  BarChart3,
  ClipboardList,
  FileClock,
  FileText,
  GraduationCap,
  Megaphone,
  Microscope,
  NotebookPen,
  Palette,
  PenLine,
  Scale,
  Telescope,
  UserCircle,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react';

/**
 * Curated 角色图标表：键 = RolePanelEntry.icon（lucide 组件名）。
 * 必须覆盖 BUILTIN_ROLES 里出现的每一个 icon 名（漂移守卫见
 * tests/renderer/components/RoleIcon.test.tsx）——不在表内的名字会静默兜底
 * UserCircle，且压掉 RoleInitialAvatar 的首字兜底档，全场渲染成同一灰色人形。
 * 另含按 7 类 SkillCategory 预留的代表图标，后续预设角色扩充时直接复用。
 */
const ROLE_ICON_MAP: Record<string, LucideIcon> = {
  Microscope, // 研究调研
  BarChart3, // 数据分析
  FileText, // 文档办公
  Palette, // 设计创意
  Megaphone, // 内容营销
  Zap, // 效率自动化
  Wrench, // 开发工程
  ClipboardList, // 牧之（产品）
  Telescope, // 溯真（调研）
  PenLine, // 青禾（写作）
  FileClock, // 明镜（审阅）
  Scale, // 持衡（合同审查）
  NotebookPen, // 记言（会议纪要）
  GraduationCap, // 万卷（文献综述）
};

interface RoleIconProps {
  /** lucide 图标名（RolePanelEntry.icon）；缺省或未知名兜底 UserCircle */
  name?: string;
  className?: string;
}

export const RoleIcon: React.FC<RoleIconProps> = ({ name, className }) => {
  const Icon = (name && ROLE_ICON_MAP[name]) || UserCircle;
  return <Icon className={className} />;
};
