// BuiltinModelList 渲染回归（多模态桥接 P1 Task 6 frontend）：
// 桥接行渲染「来自 {sourceLabel}」徽标；read-only 模式（生音乐段）不渲染默认选择 radio；
// available=false 行渲染未配置徽标。用 renderToStaticMarkup（node 环境，无 jsdom）。
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BuiltinModelList, type BuiltinRow } from '../../../src/renderer/components/features/settings/tabs/VisualModelsSettings';
import { zh } from '../../../src/renderer/i18n/zh';

const s = zh.settings.visualModels;
const cm = zh.design.customModel;
const noop = () => undefined;

const rows: BuiltinRow[] = [
  { id: 'minimax-music-2.6', label: 'MiniMax 音乐', provider: 'minimax', available: true, source: 'builtin' },
  { id: 'bridged-x', label: '桥接音乐', provider: 'deepseek', available: false, source: 'bridged', sourceLabel: 'DeepSeek' },
];

function render(readOnly: boolean): string {
  return renderToStaticMarkup(
    <BuiltinModelList
      title={s.builtinTitle}
      hint={s.defaultHint}
      rows={rows}
      availableBadge={cm.availableBadge}
      unconfiguredBadge={cm.unconfiguredBadge}
      defaultBadge={s.defaultBadge}
      bridgedFromBadge={s.bridgedFromBadge}
      onConfigure={noop}
      readOnly={readOnly}
    />,
  );
}

describe('BuiltinModelList 桥接 + 只读渲染', () => {
  it('桥接行渲染「来自 {sourceLabel}」徽标', () => {
    const html = render(true);
    expect(html).toContain(s.bridgedFromBadge.replace('{name}', 'DeepSeek'));
  });

  it('available=false 行渲染未配置徽标，available=true 渲染已配置徽标', () => {
    const html = render(true);
    expect(html).toContain(cm.unconfiguredBadge);
    expect(html).toContain(cm.availableBadge);
  });

  it('read-only 模式（生音乐段）不渲染默认选择 radio', () => {
    expect(render(true)).not.toContain('type="radio"');
  });

  it('非只读模式渲染默认选择 radio', () => {
    expect(render(false)).toContain('type="radio"');
  });
});
