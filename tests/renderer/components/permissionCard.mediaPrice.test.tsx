import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PermissionRequest as ContractPermissionRequest } from '../../../src/shared/contract/permission';
import {
  GENERATION_TOOL_DEFAULT_MODELS,
  GENERATION_TOOL_DEFAULT_VIDEO_DURATION_SEC,
} from '../../../src/shared/media/generationToolDefaults';
import { estimateImageCostCny, formatCny } from '../../../src/shared/media/imageCost';
import { estimateMusicCostCny } from '../../../src/shared/media/musicCost';
import { estimateVideoCostCny } from '../../../src/shared/media/videoCost';

// N-MEDIA-GEN-PRICE-CARD：image/video/music_generate 的审批卡必须出「按次计费 · 参考价」行，
// 数字与 shared/media/*Cost（pricing.ts 单一真源）的输出相等；普通 network/MCP 卡不出这行。
// PermissionCard 是 store 连接型组件（permissionCard.peerOrigin.test.tsx 同款 mock）。

const storeState = vi.hoisted(() => ({
  request: null as ContractPermissionRequest | null,
  language: 'zh' as 'zh' | 'en',
}));

vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const [{ zh }, { en }] = await Promise.all([
    import('../../../src/renderer/i18n/zh'),
    import('../../../src/renderer/i18n/en'),
  ]);
  return { useI18n: () => ({ t: storeState.language === 'en' ? en : zh, language: storeState.language }) };
});

vi.mock('../../../src/renderer/stores/appStore', () => {
  // zustand 两种调用形态都接（无参 = 整个 store，selector = 选取值）：
  // PermissionCard 用 useAppStore()，MediaPriceNotice 用 useAppStore((s) => s.pendingPermissionRequest)。
  const store = {
    pendingPermissionRequest: null as ContractPermissionRequest | null,
    pendingPermissionSessionId: null as string | null,
    setPendingPermissionRequest: vi.fn(),
  };
  return {
    useAppStore: (selector?: (s: typeof store) => unknown) =>
      selector ? selector({ ...store, pendingPermissionRequest: storeState.request }) : { ...store, pendingPermissionRequest: storeState.request },
  };
});

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (s: { currentSessionId: string | null }) => unknown) =>
    selector({ currentSessionId: null }),
}));

vi.mock('../../../src/renderer/stores/permissionStore', () => ({
  usePermissionStore: () => ({ checkMemory: () => null, saveMemory: vi.fn() }),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { isAvailable: () => false, invoke: vi.fn() },
}));

const { PermissionCard } = await import('../../../src/renderer/components/PermissionDialog/PermissionCard');

function render(request: ContractPermissionRequest): string {
  storeState.request = request;
  return renderToStaticMarkup(React.createElement(PermissionCard));
}

function renderInLanguage(request: ContractPermissionRequest, language: 'zh' | 'en'): string {
  storeState.language = language;
  return render(request);
}

function baseRequest(overrides: Partial<ContractPermissionRequest>): ContractPermissionRequest {
  return {
    id: 'req-media-price-1',
    tool: 'image_generate',
    type: 'network',
    forceConfirm: true,
    details: {},
    timestamp: 1,
    ...overrides,
  };
}

const IMAGE_UNIT = estimateImageCostCny(GENERATION_TOOL_DEFAULT_MODELS.image);
const VIDEO_TOTAL = estimateVideoCostCny(
  GENERATION_TOOL_DEFAULT_MODELS.video,
  GENERATION_TOOL_DEFAULT_VIDEO_DURATION_SEC,
);
const MUSIC_TOTAL = estimateMusicCostCny(GENERATION_TOOL_DEFAULT_MODELS.music);

describe('PermissionCard 付费生成工具参考价行（N-MEDIA-GEN-PRICE-CARD）', () => {
  afterEach(() => {
    storeState.language = 'zh';
  });

  it('image_generate 批量：出「N 张 × 单价 ≈ 总价」，zh/en 数字都与成本函数输出相等', () => {
    const request = baseRequest({ details: { prompt: ['一只猫', '一只狗', '一条鱼'] } as ContractPermissionRequest['details'] });
    const zh = renderInLanguage(request, 'zh');
    const en = renderInLanguage(request, 'en');
    expect(zh).toContain('data-testid="permission-media-price"');
    expect(zh).toContain(
      `按次计费 · 参考价 3 张 × ${formatCny(IMAGE_UNIT)} ≈ ${formatCny(IMAGE_UNIT * 3)}`,
    );
    expect(en).toContain('Billed per call · reference price');
    expect(en).toContain(
      `3 images × ${formatCny(IMAGE_UNIT)} ≈ ${formatCny(IMAGE_UNIT * 3)}`,
    );
  });

  it('image_generate 单条 prompt：出「参考价 ¥x / 张」，zh/en 都在', () => {
    const request = baseRequest({ details: { prompt: '一只猫的插画' } as ContractPermissionRequest['details'] });
    const zh = renderInLanguage(request, 'zh');
    const en = renderInLanguage(request, 'en');
    expect(zh).toContain(`按次计费 · 参考价 ${formatCny(IMAGE_UNIT)} / 张`);
    expect(en).toContain(`Billed per call · reference price ${formatCny(IMAGE_UNIT)} / image`);
  });

  it('video_generate：出每条参考价并复述默认时长（6 秒 / 6 s），价格=单价/秒 × 时长', () => {
    const request = baseRequest({ tool: 'video_generate', details: { prompt: '一段海浪' } as ContractPermissionRequest['details'] });
    const zh = renderInLanguage(request, 'zh');
    const en = renderInLanguage(request, 'en');
    expect(zh).toContain(
      `按次计费 · 参考价 ${formatCny(VIDEO_TOTAL)} / 条（${GENERATION_TOOL_DEFAULT_VIDEO_DURATION_SEC} 秒）`,
    );
    expect(en).toContain(
      `Billed per call · reference price ${formatCny(VIDEO_TOTAL)} / clip (${GENERATION_TOOL_DEFAULT_VIDEO_DURATION_SEC} s)`,
    );
  });

  // ai-review 返修回归：默认海螺路由 host 不传 duration（固定 6 秒片），卡片不得采信
  // args.duration——模型传 duration:10 时仍显示默认时长与对应价，不出「10 秒」。
  it('video_generate 默认路由带 duration:10：仍按默认 6 秒计价，不显示 10 秒', () => {
    const request = baseRequest({
      tool: 'video_generate',
      details: { prompt: '一段海浪', duration: 10 } as ContractPermissionRequest['details'],
    });
    const zh = renderInLanguage(request, 'zh');
    expect(zh).toContain(
      `按次计费 · 参考价 ${formatCny(VIDEO_TOTAL)} / 条（${GENERATION_TOOL_DEFAULT_VIDEO_DURATION_SEC} 秒）`,
    );
    expect(zh).not.toContain('（10 秒）');
    const en = renderInLanguage(request, 'en');
    expect(en).toContain(
      `Billed per call · reference price ${formatCny(VIDEO_TOTAL)} / clip (${GENERATION_TOOL_DEFAULT_VIDEO_DURATION_SEC} s)`,
    );
    expect(en).not.toContain('(10 s)');
  });

  it('music_generate：出每首参考价，zh/en 都在', () => {
    const request = baseRequest({ tool: 'music_generate', details: { prompt: '轻快的钢琴配乐' } as ContractPermissionRequest['details'] });
    const zh = renderInLanguage(request, 'zh');
    const en = renderInLanguage(request, 'en');
    expect(zh).toContain(`按次计费 · 参考价 ${formatCny(MUSIC_TOTAL)} / 首`);
    expect(en).toContain(`Billed per call · reference price ${formatCny(MUSIC_TOTAL)} / track`);
  });

  it('普通 network 卡（http_request 式）不出价格行，URL 详情行照旧', () => {
    const request = baseRequest({
      tool: 'http_request',
      details: { url: 'https://example.com/api', method: 'GET' } as ContractPermissionRequest['details'],
    });
    for (const language of ['zh', 'en'] as const) {
      const html = renderInLanguage(request, language);
      expect(html).not.toContain('permission-media-price');
      expect(html).not.toContain('按次计费');
      expect(html).not.toContain('Billed per call');
      expect(html).toContain('https://example.com/api');
    }
  });

  it('MCP 卡不出价格行，MCP 工具详情行照旧', () => {
    const request = baseRequest({
      tool: 'mcp',
      details: { server: 'example-server', toolName: 'example-tool' },
    });
    for (const language of ['zh', 'en'] as const) {
      const html = renderInLanguage(request, language);
      expect(html).not.toContain('permission-media-price');
      expect(html).not.toContain('按次计费');
      expect(html).not.toContain('Billed per call');
      expect(html).toContain('example-server / example-tool');
    }
  });

  it('image_generate 参数不成立（无 prompt）时不出价格行', () => {
    const request = baseRequest({ details: {} });
    expect(render(request)).not.toContain('permission-media-price');
  });
});
