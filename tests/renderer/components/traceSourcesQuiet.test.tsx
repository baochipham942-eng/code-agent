import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TraceNodeRenderer } from '../../../src/renderer/components/features/chat/TraceNodeRenderer';
import type { TraceNode } from '../../../src/shared/contract/trace';
import type { TurnArtifactOwnershipItem } from '../../../src/shared/contract/turnTimeline';

function makeNode(items: TurnArtifactOwnershipItem[]): TraceNode {
  return {
    id: 'turn-1-artifact-ownership',
    type: 'turn_timeline',
    content: '',
    timestamp: 1000,
    turnTimeline: {
      id: 'turn-1-artifact-ownership',
      kind: 'artifact_ownership',
      timestamp: 1000,
      tone: 'success',
      artifactOwnership: items,
    },
  } as TraceNode;
}

const linkItem = (label: string): TurnArtifactOwnershipItem => ({
  kind: 'link',
  label,
  ownerKind: 'tool',
  ownerLabel: 'WebFetch',
  url: `https://${label}`,
});

const fileItem = (label: string): TurnArtifactOwnershipItem => ({
  kind: 'file',
  label,
  ownerKind: 'assistant',
  ownerLabel: 'Write',
  path: `/work/${label}`,
});

describe('Sources (纯链接来源) 视觉降级 — 不长得像交付物卡', () => {
  it('纯链接来源容器用中性灰，不用 success 绿框/绿底/绿图标', () => {
    const html = renderToStaticMarkup(
      <TraceNodeRenderer node={makeNode([linkItem('xingyun3d.csdn.net'), linkItem('aiapps.com')])} />,
    );
    // 仍是「来源」标签 + 卡片形态（保留 Link 徽标）
    expect(html).toContain('Sources');
    expect(html).toContain('Link');
    // 不再有 success 绿色 chrome
    expect(html).not.toContain('border-emerald-500');
    expect(html).not.toContain('bg-emerald-500');
    expect(html).not.toContain('text-emerald-300');
    // 改用中性灰卡片
    expect(html).toContain('border-white/[0.06]');
  });

  it('含真实产物（artifact）时仍标 Outputs、保留强调色（不受本次降级影响）', () => {
    const html = renderToStaticMarkup(
      <TraceNodeRenderer
        node={makeNode([
          linkItem('aiapps.com'),
          { kind: 'artifact', label: '报告.pdf', ownerKind: 'assistant', ownerLabel: 'Assistant' },
        ])}
      />,
    );
    expect(html).toContain('Outputs');
    expect(html).toContain('border-emerald-500');
  });

  it('文件+来源混合：文件进绿 Outputs，WebFetch 来源拆出到独立中性 Sources 块（不当产物）', () => {
    const html = renderToStaticMarkup(
      <TraceNodeRenderer node={makeNode([fileItem('简报.md'), linkItem('sohu.com'), linkItem('cnyes.com')])} />,
    );
    // 两个区块都在：绿 Outputs（真文件产物）+ 中性 Sources（来源链接）
    expect(html).toContain('Outputs');
    expect(html).toContain('Sources');
    expect(html).toContain('border-emerald-500'); // Outputs 绿
    expect(html).toContain('border-white/[0.06]'); // Sources 中性灰
    // Sources 区出现在 Outputs 之后（来源在产物下方、降级呈现）
    expect(html.indexOf('Outputs')).toBeLessThan(html.indexOf('Sources'));
    // 文件名与来源域名都在
    expect(html).toContain('简报.md');
    expect(html).toContain('sohu.com');
    expect(html).toContain('cnyes.com');
  });
});
