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
  FileText,
  Megaphone,
  Microscope,
  Palette,
  UserCircle,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react';

/**
 * Curated 角色图标表：键 = RolePanelEntry.icon（lucide 组件名）。
 * 当前预设角色用 Microscope / BarChart3；其余为按 7 类 SkillCategory 预留的
 * 代表图标，方便后续预设角色扩充时直接复用，不必每次改渲染逻辑。
 */
const ROLE_ICON_MAP: Record<string, LucideIcon> = {
  Microscope, // 研究调研
  BarChart3, // 数据分析
  FileText, // 文档办公
  Palette, // 设计创意
  Megaphone, // 内容营销
  Zap, // 效率自动化
  Wrench, // 开发工程
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
