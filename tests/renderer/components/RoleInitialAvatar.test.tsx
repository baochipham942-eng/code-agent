// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RoleInitialAvatar } from '../../../src/renderer/components/features/expert/RoleInitialAvatar';
import { getRoleAvatarAsset } from '../../../src/renderer/components/features/expert/roleAvatarAssets';

afterEach(cleanup);

describe('roleAvatarAssets', () => {
  it('8 个官方 roleId 都命中非空头像资产', () => {
    const roleIds = ['数据分析师', '牧之', '溯真', '青禾', '明镜', '岚析', '映川', '研究员'];

    for (const roleId of roleIds) {
      expect(getRoleAvatarAsset(roleId), roleId).toEqual(expect.any(String));
      expect(getRoleAvatarAsset(roleId)?.length, roleId).toBeGreaterThan(0);
    }
    expect(getRoleAvatarAsset('用户自建角色')).toBeUndefined();
  });
});

describe('RoleInitialAvatar', () => {
  it('内置 roleId 渲染圆形图片并保留尺寸、测试标识和可访问名称', () => {
    render(<RoleInitialAvatar roleId="牧之" name="牧之" className="h-5 w-5 text-[10px]" />);

    const avatar = screen.getByTestId('role-initial-avatar-牧之');
    expect(avatar.tagName).toBe('IMG');
    expect(avatar.getAttribute('src')).toBe(getRoleAvatarAsset('牧之'));
    expect(avatar.className).toContain('h-5 w-5');
    expect(avatar.className).toContain('rounded-full');
    expect(avatar.className).toContain('object-cover');
    expect(avatar.getAttribute('aria-label')).toBe('牧之');
  });

  it('未知 roleId 保持首字兜底', () => {
    render(<RoleInitialAvatar roleId="用户自建角色" name="阿问" />);

    const avatar = screen.getByTestId('role-initial-avatar-用户自建角色');
    expect(avatar.tagName).toBe('SPAN');
    expect(avatar.textContent).toBe('阿');
    expect(avatar.getAttribute('aria-label')).toBe('阿问');
  });
});
