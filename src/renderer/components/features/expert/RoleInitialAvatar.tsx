import React from 'react';

export function roleInitial(value: string): string {
  const trimmed = value.trim();
  return trimmed ? Array.from(trimmed)[0].toLocaleUpperCase() : '?';
}

export function roleAvatarColor(roleId: string): string {
  let hash = 0;
  for (let index = 0; index < roleId.length; index += 1) hash = ((hash * 31) + roleId.charCodeAt(index)) | 0;
  return `hsl(${Math.abs(hash) % 360} 58% 44%)`;
}

export const RoleInitialAvatar: React.FC<{
  roleId: string;
  name?: string;
  className?: string;
}> = ({ roleId, name, className = 'h-8 w-8 text-xs' }) => (
  <span
    data-testid={`role-initial-avatar-${roleId}`}
    data-role-color={roleAvatarColor(roleId)}
    className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white ${className}`}
    style={{ backgroundColor: roleAvatarColor(roleId) }}
    aria-label={name || roleId}
  >
    {roleInitial(name || roleId)}
  </span>
);
