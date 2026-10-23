// @vitest-environment jsdom
// N-MODELCAT-SERVICE-TIER-COST：设置页「无人值守半价档」说明行——zh/en 双语都在场，
// 展示的倍率数字从 SERVICE_TIER_COST_MULTIPLIER 常量注入，文案里不落 0.5 字面量。
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { zhSettingsModels } from '../../../src/renderer/i18n/zhSettingsModels';
import { enSettingsModels } from '../../../src/renderer/i18n/enSettingsModels';
import {
  SERVICE_TIER_COST_MULTIPLIER,
  UNATTENDED_SERVICE_TIER,
} from '../../../src/shared/constants';

const { useI18nMock } = vi.hoisted(() => ({ useI18nMock: vi.fn() }));
vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: useI18nMock }));

import { ServiceTierCostNote } from '../../../src/renderer/components/features/settings/tabs/ServiceTierCostNote';

const EXPECTED_MULTIPLIER = SERVICE_TIER_COST_MULTIPLIER[UNATTENDED_SERVICE_TIER];
const ZH_NOTE = '无人值守任务自动用半价档（约 0.5×，被拒自动回标准价）';
const EN_NOTE = 'Unattended tasks automatically use the half-price tier (about 0.5x); if it is declined, they fall back to the standard price.';

function renderNote(): string {
  const { container } = render(<ServiceTierCostNote />);
  return container.textContent ?? '';
}

afterEach(() => cleanup());

describe('ServiceTierCostNote 双语文案与常量倍率', () => {
  it('zh：完整句子在场，{multiplier} 占位被常量值替换', () => {
    useI18nMock.mockReturnValue({ t: { settings: zhSettingsModels } });
    expect(renderNote()).toBe(ZH_NOTE);
  });

  it('en：完整句子在场，{multiplier} 占位被常量值替换', () => {
    useI18nMock.mockReturnValue({ t: { settings: enSettingsModels } });
    expect(renderNote()).toBe(EN_NOTE);
  });

  it('文案只留占位符，倍率数字来自常量（改倍率只改 serviceTier.ts）', () => {
    // 常量是折价档的单一源：展示值必须由它推导，而不是写死在文案里
    expect(EXPECTED_MULTIPLIER).toBe(0.5);
    expect(zhSettingsModels.model.serviceTierCostNote).toBe('无人值守任务自动用半价档（约 {multiplier}×，被拒自动回标准价）');
    expect(enSettingsModels.model.serviceTierCostNote).toBe(
      'Unattended tasks automatically use the half-price tier (about {multiplier}x); if it is declined, they fall back to the standard price.',
    );

    useI18nMock.mockReturnValue({ t: { settings: zhSettingsModels } });
    expect(renderNote()).toContain(`约 ${String(EXPECTED_MULTIPLIER)}×`);
  });
});
