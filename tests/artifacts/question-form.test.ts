import { describe, it, expect } from 'vitest';
import {
  parseQuestionForm,
  renderQuestionFormToDesignBrief,
} from '@/artifacts/question-form';

const wrap = (json: string) => '```question-form\n' + json + '\n```';

describe('parseQuestionForm', () => {
  it('parses a complete form with all optional fields', () => {
    const input = wrap(JSON.stringify({
      surface: 'landing_page',
      direction: 'premium',
      intent: '为新功能写发布页',
      audience: '现有付费用户',
      constraints: ['品牌色锁死', ' 不要英文标题 ', '品牌色锁死'],
      references: ['https://stripe.com', 'https://linear.app'],
    }));

    const result = parseQuestionForm(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form.surface).toBe('landing_page');
    expect(result.form.direction).toBe('premium');
    expect(result.form.intent).toBe('为新功能写发布页');
    expect(result.form.audience).toBe('现有付费用户');
    expect(result.form.constraints).toEqual(['品牌色锁死', '不要英文标题']);
    expect(result.form.references).toHaveLength(2);
  });

  it('accepts missing audience as a soft optional', () => {
    const input = wrap(JSON.stringify({
      surface: 'app_screen',
      direction: 'utilitarian',
    }));

    const result = parseQuestionForm(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.form.audience).toBeUndefined();
    expect(result.form.constraints).toBeUndefined();
    expect(result.form.references).toBeUndefined();
  });

  it('rejects when surface is missing', () => {
    const input = wrap(JSON.stringify({ direction: 'editorial' }));
    const result = parseQuestionForm(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/surface/);
  });

  it('rejects an invalid direction value', () => {
    const input = wrap(JSON.stringify({
      surface: 'document',
      direction: 'cyberpunk',
    }));
    const result = parseQuestionForm(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/direction/);
  });

  it('parses bare json body without fence', () => {
    const input = JSON.stringify({ surface: 'dashboard', direction: 'technical' });
    const result = parseQuestionForm(input);
    expect(result.ok).toBe(true);
  });

  it('rejects malformed json gracefully', () => {
    const result = parseQuestionForm('```question-form\n{not valid json}\n```');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/json/);
  });
});

describe('renderQuestionFormToDesignBrief', () => {
  it('maps required fields and stamps source=manual', () => {
    const brief = renderQuestionFormToDesignBrief({
      surface: 'presentation',
      direction: 'editorial',
    });
    expect(brief.surface).toBe('presentation');
    expect(brief.direction).toBe('editorial');
    expect(brief.source).toBe('manual');
    expect(brief.intent).toBeUndefined();
  });

  it('passes through optional fields when present', () => {
    const brief = renderQuestionFormToDesignBrief({
      surface: 'component',
      direction: 'playful',
      intent: '搞个庆祝弹层',
      audience: '内部团队',
      constraints: ['不要烟花', '不要全屏遮罩'],
      references: ['https://retool.com/celebrate'],
    });
    expect(brief.intent).toBe('搞个庆祝弹层');
    expect(brief.audience).toBe('内部团队');
    expect(brief.constraints).toEqual(['不要烟花', '不要全屏遮罩']);
    expect(brief.references).toEqual(['https://retool.com/celebrate']);
  });
});
