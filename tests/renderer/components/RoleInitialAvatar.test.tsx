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

  // N-ROLE-PACKS-PILOT3 r1：无头像资产的新内置角色走 icon 档，必须渲染专属
  // lucide 字形而非 UserCircle 兜底人形（icon 非空未知名会同时压掉首字档）。
  it('无头像资产的新内置角色（持衡）icon 档渲染专属图标，不兜底人形', () => {
    expect(getRoleAvatarAsset('持衡')).toBeUndefined();

    render(<RoleInitialAvatar roleId="持衡" name="持衡" icon="Scale" />);

    const avatar = screen.getByTestId('role-initial-avatar-持衡');
    expect(avatar.tagName).toBe('SPAN');
    const svgClass = avatar.querySelector('svg')?.getAttribute('class') ?? '';
    expect(svgClass).toContain('lucide-scale');
    expect(svgClass).not.toContain('lucide-circle-user');
    expect(avatar.textContent).toBe('');
  });
});
