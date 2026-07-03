import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../../..');

function readSource(relativePath: string): string {
  return readFileSync(path.join(ROOT, relativePath), 'utf8');
}

describe('main task model copy', () => {
  it('uses main task model wording in chat send readiness prompts', () => {
    const source = readSource('src/renderer/components/ChatView.tsx');

    expect(source).toContain('当前主任务模型未配置 API Key');
    expect(source).not.toContain('当前默认模型未配置 API Key');
  });

  it('uses main task model wording during first-run model onboarding', () => {
    const source = readSource('src/renderer/components/onboarding/ModelOnboardingModal.tsx');

    expect(source).toContain('正在保存主任务模型');
    expect(source).not.toContain('正在保存默认模型');
  });

  it('explains model selection-page gating and default in settings', () => {
    // 设置页模型区精简后：模型行用「进选择页」开关 + 「设为默认」表达 gating 与默认。
    // 文案已迁 i18n（settings 内容区 i18n 批3），断言指向 zh 真源 + 组件引用对应键。
    const models = zh.settings.model.models;
    expect(models.selectableLabel).toBe('进选择页');
    expect(models.selectionHint).toContain('「设为默认」决定 Neo 默认用哪个');

    const source = readSource('src/renderer/components/features/settings/tabs/ProviderModelsSection.tsx');
    expect(source).toContain('selectableLabel');
    expect(source).toContain('selectionHint');
  });
});
