// ============================================================================
// RoleAvatarTile - 专家卡片头的方形头像瓦片
// ============================================================================
//
// 命中 roleAvatarAssets 的角色渲染真人头像，未命中回落原来的 lucide 图标瓦片
// （用户自建角色、云货架新角色都走回落）。#755 只把头像接进了聊天侧的
// RoleInitialAvatar（圆形），货架卡/专家团卡/详情页这条路没接，才有「新包里
// 看不到头像」——它们渲染的一直是 RoleIcon。
// ============================================================================

import React from 'react';
import { RoleIcon } from '../shared/RoleIcon';
import { getRoleAvatarAsset } from './roleAvatarAssets';

export const RoleAvatarTile: React.FC<{
  roleId: string;
  icon?: string;
  name?: string;
}> = ({ roleId, icon, name }) => {
  const avatarAsset = getRoleAvatarAsset(roleId);

  if (avatarAsset) {
    return (
      <img
        src={avatarAsset}
        alt={name || roleId}
        data-testid={`role-avatar-tile-${roleId}`}
        className="h-9 w-9 flex-shrink-0 rounded-lg object-cover"
      />
    );
  }

  return (
    <span
      data-testid={`role-avatar-tile-${roleId}`}
      className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-violet-500/10"
    >
      <RoleIcon name={icon} className="h-5 w-5" />
    </span>
  );
};
