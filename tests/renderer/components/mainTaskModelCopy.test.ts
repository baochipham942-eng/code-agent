import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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

  it('explains main task model selection as a task strategy in settings', () => {
    const source = readSource('src/renderer/components/features/settings/tabs/ModelSettings.tsx');

    expect(source).toContain('主任务模型会影响每一轮交付质量');
    expect(source).toContain('日常小任务避免长期锁定慢模型或按量昂贵模型');
    expect(source).toContain('自动模式会按任务、成本、速度和能力尝试切换');
  });
});
