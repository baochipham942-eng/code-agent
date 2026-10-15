// @vitest-environment jsdom
// ============================================================================
// RoleIcon × BUILTIN_ROLES 漂移守卫（N-ROLE-PACKS-PILOT3 r1）
// ============================================================================
//
// 内置角色的 visual.icon 是数据侧自由字符串，渲染侧唯一消费表是 RoleIcon 的
// curated ROLE_ICON_MAP：不在表内的名字静默兜底 UserCircle，且因 icon 非空
// 连 RoleInitialAvatar 的首字兜底档也被跳过（三级回落：资产 → icon → 首字）。
// 有真人头像资产的角色被资产档遮蔽看不出问题；无资产的新角色会全场渲染成同
// 一个灰色人形。本测试把「每个内置角色的 icon 都能渲染出专属字形」钉成不变量。
// ============================================================================
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RoleIcon } from '../../../src/renderer/components/features/shared/RoleIcon';
import { BUILTIN_ROLES } from '../../../src/host/services/roleAssets/builtinRoles';

afterEach(cleanup);

/** lucide v1.16 里 UserCircle 兜底字形的规范名（改名前是 lucide-user-circle） */
const FALLBACK_GLYPH = 'lucide-circle-user';

const svgClassOf = (icon: string): string => {
  const { container } = render(<RoleIcon name={icon} />);
  return container.querySelector('svg')?.getAttribute('class') ?? '';
};

describe('RoleIcon × BUILTIN_ROLES 漂移守卫', () => {
  it('每个内置角色的 visual.icon 都渲染专属字形，不兜底 UserCircle', () => {
    expect(BUILTIN_ROLES.length).toBeGreaterThanOrEqual(8);

    const classes: string[] = [];
    for (const role of BUILTIN_ROLES) {
      const cls = svgClassOf(role.visual.icon);
      expect(cls, `${role.id}(${role.visual.icon}) 应渲染出 svg 图标`).toMatch(/^lucide /);
      expect(cls, `${role.id}(${role.visual.icon}) 不应兜底 UserCircle 人形`).not.toContain(
        FALLBACK_GLYPH,
      );
      classes.push(cls);
    }

    // 不同 icon 名必须渲染不同字形——全场同一个灰色人形就是本缺陷的形态
    expect(new Set(classes).size).toBe(
      new Set(BUILTIN_ROLES.map((role) => role.visual.icon)).size,
    );
  });

  it('持衡/记言/万卷 渲染各自设计的图标字形', () => {
    const expectedGlyphs: Record<string, string> = {
      持衡: 'lucide-scale',
      记言: 'lucide-notebook-pen',
      万卷: 'lucide-graduation-cap',
    };

    for (const [roleId, glyph] of Object.entries(expectedGlyphs)) {
      const role = BUILTIN_ROLES.find((entry) => entry.id === roleId);
      expect(role, `缺少内置角色 ${roleId}`).toBeTruthy();
      expect(
        svgClassOf(role?.visual.icon ?? ''),
        `${roleId} 应渲染 ${glyph}`,
      ).toContain(glyph);
    }
  });
});
