import { afterEach, describe, expect, it, vi } from 'vitest';
import { directionTokens } from '../../../../src/design/direction-tokens';
import type { BrandContract } from '../../../../src/shared/contract/brandContract';

// 强绑注入测试：mock brandRegistry.getActiveBrandSync，验证 enrich（经
// buildWorkbenchTurnSystemContext → <design_brief_json>）把 active 品牌 tokens +
// brandContract 注入进序列化 brief。
vi.mock('../../../../src/host/services/design/brandRegistry', () => ({
  getActiveBrandSync: vi.fn(),
}));

import { getActiveBrandSync } from '../../../../src/host/services/design/brandRegistry';
import { buildWorkbenchTurnSystemContext } from '../../../../src/host/app/workbenchTurnContext';

const mockActive = getActiveBrandSync as unknown as ReturnType<typeof vi.fn>;

const activeBrand: BrandContract = {
  id: 'porsche-x',
  name: 'Porsche 数字化',
  tokens: directionTokens.premium,
  keep: ['克制留白'],
  change: ['主色可浮动'],
  doNotCopy: ['不要渐变按钮', '不要 emoji 图标'],
  source: 'manual',
  createdAt: 1,
  updatedAt: 2,
};

function extractBriefJson(lines: string[]): any {
  const joined = lines.join('\n');
  const m = joined.match(/<design_brief_json>\n([\s\S]*?)\n<\/design_brief_json>/);
  if (!m) return null;
  return JSON.parse(m[1]);
}

afterEach(() => {
  mockActive.mockReset();
});

describe('brand force-injection via buildWorkbenchTurnSystemContext', () => {
  it('injects active brand tokens + brandContract when brief has no direction/tokens', () => {
    mockActive.mockReturnValue(activeBrand);
    const lines = buildWorkbenchTurnSystemContext({
      designBrief: { intent: '做一个落地页', surface: 'landing_page' },
    } as any);
    const brief = extractBriefJson(lines);
    expect(brief).toBeTruthy();
    // tokens 兜底为品牌 tokens
    expect(brief.directionTokens).toEqual(directionTokens.premium);
    // brandContract 三桶注入
    expect(brief.brandContract).toEqual({
      keep: ['克制留白'],
      change: ['主色可浮动'],
      doNotCopy: ['不要渐变按钮', '不要 emoji 图标'],
    });
  });

  it('explicit per-task direction wins for tokens, but brand doNotCopy still applies', () => {
    mockActive.mockReturnValue(activeBrand);
    const lines = buildWorkbenchTurnSystemContext({
      designBrief: { intent: 'x', direction: 'calm' },
    } as any);
    const brief = extractBriefJson(lines);
    // direction=calm 显式胜出，tokens 来自 calm 而非品牌 premium
    expect(brief.directionTokens).toEqual(directionTokens.calm);
    // 品牌的 do-not-copy 约束仍生效
    expect(brief.brandContract.doNotCopy).toEqual(['不要渐变按钮', '不要 emoji 图标']);
  });

  it('does not overwrite a brandContract the brief already carries', () => {
    mockActive.mockReturnValue(activeBrand);
    const lines = buildWorkbenchTurnSystemContext({
      designBrief: {
        intent: 'x',
        brandContract: { keep: ['自带keep'], change: [], doNotCopy: ['自带禁止'] },
      },
    } as any);
    const brief = extractBriefJson(lines);
    expect(brief.brandContract).toEqual({ keep: ['自带keep'], change: [], doNotCopy: ['自带禁止'] });
  });

  it('no active brand → brief carries neither brand tokens nor brandContract', () => {
    mockActive.mockReturnValue(null);
    const lines = buildWorkbenchTurnSystemContext({
      designBrief: { intent: 'x', surface: 'document' },
    } as any);
    const brief = extractBriefJson(lines);
    expect(brief.directionTokens).toBeUndefined();
    expect(brief.brandContract).toBeUndefined();
  });

  it('injects active brand as acceptance contract brand ref without overwriting contract intent', () => {
    mockActive.mockReturnValue(activeBrand);
    const lines = buildWorkbenchTurnSystemContext({
      designAcceptanceContract: {
        version: 1,
        intent: 'agent_convergence',
        acceptanceCriteria: ['必须保留用户选中的主版视觉方向'],
        lockedRegions: [],
        brandRefs: [],
      },
    } as any);
    const joined = lines.join('\n');
    const match = joined.match(/<design_acceptance_contract_json>\n([\s\S]*?)\n<\/design_acceptance_contract_json>/);
    expect(match).toBeTruthy();
    const contract = JSON.parse(match![1]);
    expect(contract.intent).toBe('agent_convergence');
    expect(contract.brandRefs[0]).toMatchObject({
      id: 'porsche-x',
      name: 'Porsche 数字化',
      source: 'active_brand',
      contract: {
        keep: ['克制留白'],
        change: ['主色可浮动'],
        doNotCopy: ['不要渐变按钮', '不要 emoji 图标'],
      },
    });
    expect(contract.brandRefs[0].tokens).toEqual(directionTokens.premium);
  });
});
