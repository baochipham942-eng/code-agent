import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  outcomeWordsEn,
  outcomeWordsZh,
} from '../../../src/renderer/i18n/outcomeWords';

const I18N_DIR = path.resolve(process.cwd(), 'src/renderer/i18n');

const OUTCOME_KEYS = [
  'cancelled-by-user',
  'cancelled-session-switch',
  'cancelled-restart',
  'cancelled-by-parent',
  'failed-tool',
  'failed-model',
  'failed-unknown',
  'failed-approval-denied',
  'failed-timeout',
  'failed-budget',
  'failed-dependency',
  'failed-unavailable',
  'completed',
  'completed-with-warnings',
  'aborted',
  'goal-met',
] as const;

const OUTCOME_AUDIENCES = ['timeline', 'badge', 'detail', 'notification'] as const;

const LEGACY_DICTIONARIES = [
  'chatTranscript.ts',
  'sessionInspector.ts',
  'workbenchTabs.ts',
  'cronCenter.ts',
  'taskStatusPanels.ts',
  'surfaceExecution.ts',
  'voice.ts',
  'capabilityHub.ts',
  'sessionReplay.ts',
  'chatInput.ts',
  'modalPrimitives.ts',
  'zhSettingsWork.ts',
  'zhSettingsSystem.ts',
] as const;

const FORBIDDEN_TERMINAL_LITERALS = [
  '已中断',
  '已取消',
  '被打断',
  '失败',
  '失败了',
  '未完成',
  '出错了',
  '执行失败',
  'Interrupted',
  'Cancelled',
  'Canceled',
  'Failed',
  'Incomplete',
  'Something went wrong',
  'Execution failed',
] as const;

function quotedLiteralPattern(literal: string): RegExp {
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(['"])${escaped}\\1`, 'u');
}

describe('outcomeWords contract', () => {
  it('keeps terminal-word literals out of the 13 legacy dictionaries', () => {
    const violations: string[] = [];

    for (const file of LEGACY_DICTIONARIES) {
      const source = fs.readFileSync(path.join(I18N_DIR, file), 'utf8');
      for (const literal of FORBIDDEN_TERMINAL_LITERALS) {
        if (quotedLiteralPattern(literal).test(source)) {
          violations.push(`${file}: ${literal}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('covers every outcome and audience with matching zh/en keys and non-empty copy', () => {
    expect(Object.keys(outcomeWordsZh.outcomeWords)).toEqual([...OUTCOME_KEYS]);
    expect(Object.keys(outcomeWordsEn.outcomeWords)).toEqual([...OUTCOME_KEYS]);

    for (const outcome of OUTCOME_KEYS) {
      const zh = outcomeWordsZh.outcomeWords[outcome];
      const en = outcomeWordsEn.outcomeWords[outcome];
      expect(Object.keys(zh)).toEqual([...OUTCOME_AUDIENCES]);
      expect(Object.keys(en)).toEqual([...OUTCOME_AUDIENCES]);

      for (const audience of OUTCOME_AUDIENCES) {
        expect(zh[audience].label.trim(), `zh ${outcome}/${audience} label`).not.toBe('');
        expect(zh[audience].reason.trim(), `zh ${outcome}/${audience} reason`).not.toBe('');
        expect(en[audience].label.trim(), `en ${outcome}/${audience} label`).not.toBe('');
        expect(en[audience].reason.trim(), `en ${outcome}/${audience} reason`).not.toBe('');
      }
    }
  });

  it('gives every badge outcome a reason phrase', () => {
    for (const outcome of OUTCOME_KEYS) {
      expect(outcomeWordsZh.outcomeWords[outcome].badge.reason.trim(), `zh ${outcome}`).not.toBe('');
      expect(outcomeWordsEn.outcomeWords[outcome].badge.reason.trim(), `en ${outcome}`).not.toBe('');
    }
  });
});
