// CustomImageModelManagerView 渲染回归（借鉴项① Phase3 frontend）：
// 列表模式渲染模型名 + 已配置/未配置徽标 + 新增/删除入口；
// 表单模式渲染显示名/Base URL/模型名/API Key/成本字段 + 保存/返回。
// 用 renderToStaticMarkup（node 环境，无 jsdom），i18n 取 zh.design.customModel。
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CustomImageModelManagerView } from '../../../src/renderer/components/design/CustomImageModelManager';
import { zh } from '../../../src/renderer/i18n/zh';
import type { CustomImageModelMeta } from '../../../src/renderer/components/design/designFiles';

const s = zh.design.customModel;

const models: CustomImageModelMeta[] = [
  { id: 'sdxl-abc', label: '我的 SDXL', baseUrl: 'https://api.x.com/v1', modelName: 'sdxl', available: true },
  { id: 'nokey-def', label: '没配 Key 的', baseUrl: 'https://api.y.com/v1', modelName: 'm', available: false },
];

const emptyForm = { label: '', baseUrl: '', modelName: '', apiKey: '', cost: '' };
const noop = () => undefined;

function renderList(list = models): string {
  return renderToStaticMarkup(
    <CustomImageModelManagerView
      s={s} models={list} mode="list" form={emptyForm} saving={false}
      onCreate={noop} onDelete={noop} onBack={noop} onFormChange={noop} onSave={noop}
    />,
  );
}

function renderForm(): string {
  return renderToStaticMarkup(
    <CustomImageModelManagerView
      s={s} models={models} mode="form" form={emptyForm} saving={false}
      onCreate={noop} onDelete={noop} onBack={noop} onFormChange={noop} onSave={noop}
    />,
  );
}

describe('CustomImageModelManagerView 列表模式', () => {
  it('渲染每个模型的显示名', () => {
    const html = renderList();
    expect(html).toContain('我的 SDXL');
    expect(html).toContain('没配 Key 的');
  });
  it('已配置/未配置各显示对应徽标', () => {
    const html = renderList();
    expect(html).toContain(s.availableBadge);
    expect(html).toContain(s.unconfiguredBadge);
  });
  it('空列表渲染空态文案', () => {
    expect(renderList([])).toContain(s.empty);
  });
  it('渲染「新增」入口', () => {
    expect(renderList()).toContain(s.create);
  });
});

describe('CustomImageModelManagerView 表单模式', () => {
  it('渲染各字段标签 + 保存/返回', () => {
    const html = renderForm();
    expect(html).toContain(s.nameLabel);
    expect(html).toContain(s.baseUrlLabel);
    expect(html).toContain(s.modelNameLabel);
    expect(html).toContain(s.apiKeyLabel);
    expect(html).toContain(s.save);
    expect(html).toContain(s.back);
  });
});
