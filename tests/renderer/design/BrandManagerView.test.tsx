// BrandManagerView 渲染回归（CD-Parity §1 B1 frontend）：
// 列表模式渲染品牌名 + active 指示 + 设为活跃/编辑/删除入口；
// 表单模式渲染 5 色板 + 双字体 + 气质 + Keep/Change/Do-not-copy 三桶。
// 用 renderToStaticMarkup（node 环境，无 jsdom），i18n 取 zh.design.brand。
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BrandManagerView } from '../../../src/renderer/components/design/BrandManager';
import { zh } from '../../../src/renderer/i18n/zh';
import { directionTokens } from '../../../src/design/direction-tokens';
import type { BrandMeta } from '../../../src/shared/contract/brandContract';

const s = zh.design.brand;

const brands: BrandMeta[] = [
  { id: 'porsche-abc123', name: 'Porsche 数字化', updatedAt: 200 },
  { id: 'lobster-def456', name: '龙虾平台', updatedAt: 100 },
];

const baseForm = {
  name: '新品牌',
  palette: { ...directionTokens.utilitarian.palette },
  fonts: { ...directionTokens.utilitarian.fonts },
  posture: directionTokens.utilitarian.posture,
  refs: [...directionTokens.utilitarian.refs],
  keep: ['圆角克制，大量留白'],
  change: ['主色可在深浅间浮动'],
  doNotCopy: ['不要渐变按钮', '不要 emoji 图标'],
};

const noop = () => undefined;

function renderList(activeId?: string): string {
  return renderToStaticMarkup(
    <BrandManagerView
      s={s}
      brands={brands}
      activeId={activeId}
      mode="list"
      form={baseForm}
      saving={false}
      onSetActive={noop}
      onDelete={noop}
      onCreate={noop}
      onEdit={noop}
      onFormChange={noop}
      onSave={noop}
      onBack={noop}
    />,
  );
}

function renderForm(): string {
  return renderToStaticMarkup(
    <BrandManagerView
      s={s}
      brands={brands}
      mode="form"
      form={baseForm}
      saving={false}
      onSetActive={noop}
      onDelete={noop}
      onCreate={noop}
      onEdit={noop}
      onFormChange={noop}
      onSave={noop}
      onBack={noop}
    />,
  );
}

describe('BrandManagerView 列表模式', () => {
  it('渲染所有已保存品牌名 + 新建入口', () => {
    const html = renderList();
    expect(html).toContain('Porsche 数字化');
    expect(html).toContain('龙虾平台');
    expect(html).toContain(s.create);
    expect(html).toContain(s.listTitle);
  });

  it('active 品牌显示活跃徽标，且只标一个', () => {
    const html = renderList('porsche-abc123');
    expect(html).toContain(s.activeBadge);
    // 活跃的那个显示「取消活跃」，另一个显示「设为活跃」
    expect(html).toContain(s.unsetActive);
    expect(html).toContain(s.setActive);
    // 仅一个徽标
    expect(html.split(s.activeBadge)).toHaveLength(2);
  });

  it('无活跃品牌时两个都显示「设为活跃」、无徽标', () => {
    const html = renderList(undefined);
    expect(html).not.toContain(s.activeBadge);
    expect(html.split(s.setActive)).toHaveLength(3); // 2 个 setActive
  });

  it('空列表显示空态提示', () => {
    const html = renderToStaticMarkup(
      <BrandManagerView
        s={s}
        brands={[]}
        mode="list"
        form={baseForm}
        saving={false}
        onSetActive={noop}
        onDelete={noop}
        onCreate={noop}
        onEdit={noop}
        onFormChange={noop}
        onSave={noop}
        onBack={noop}
      />,
    );
    expect(html).toContain(s.empty);
  });
});

describe('BrandManagerView 表单模式', () => {
  it('渲染名称 + 5 色板标签 + 双字体 + 气质', () => {
    const html = renderForm();
    expect(html).toContain(s.nameLabel);
    expect(html).toContain(s.colorPrimary);
    expect(html).toContain(s.colorSurface);
    expect(html).toContain(s.colorAccent);
    expect(html).toContain(s.colorMuted);
    expect(html).toContain(s.colorContrast);
    expect(html).toContain(s.fontSerif);
    expect(html).toContain(s.fontSans);
    expect(html).toContain(s.postureLabel);
  });

  it('渲染 Keep / Change / Do-not-copy 三桶 + 当前行值', () => {
    const html = renderForm();
    expect(html).toContain(s.keepLabel);
    expect(html).toContain(s.changeLabel);
    expect(html).toContain(s.doNotCopyLabel);
    // do-not-copy 两行的值都渲染出来
    expect(html).toContain('不要渐变按钮');
    expect(html).toContain('不要 emoji 图标');
  });

  it('色板 swatch 用品牌色值作动态背景（非组件硬编码）', () => {
    const html = renderForm();
    // utilitarian primary 是 oklch 值，作为 inline style 出现
    expect(html).toContain(directionTokens.utilitarian.palette.primary);
  });

  it('表单底部有保存 + 返回入口', () => {
    const html = renderForm();
    expect(html).toContain(s.save);
    expect(html).toContain(s.back);
  });

  it('error 文案在传入时渲染', () => {
    const html = renderToStaticMarkup(
      <BrandManagerView
        s={s}
        brands={brands}
        mode="form"
        form={baseForm}
        saving={false}
        error={s.nameRequired}
        onSetActive={noop}
        onDelete={noop}
        onCreate={noop}
        onEdit={noop}
        onFormChange={noop}
        onSave={noop}
        onBack={noop}
      />,
    );
    expect(html).toContain(s.nameRequired);
  });
});
