// @vitest-environment jsdom
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolCall } from '../../../src/shared/contract';
import { describeParkedApprovalClosure } from '../../../src/host/agent/parkedApprovalSurvival';

// 语言可切换（真 useI18n 按 appStore.language 选词表）；默认 zh，en 用例临时切换。
const languageState = vi.hoisted(() => ({ value: 'zh' as 'zh' | 'en' }));

vi.mock('../../../src/renderer/stores/appStore', () => {
  const makeState = () => ({
    processingSessionIds: new Set<string>(),
    openPreview: vi.fn(),
    workingDirectory: '/repo',
    language: languageState.value,
    setLanguage: vi.fn(),
    cloudUIStrings: undefined,
  });
  return {
    useAppStore: (selector?: (value: ReturnType<typeof makeState>) => unknown) => {
      const state = makeState();
      return selector ? selector(state) : state;
    },
  };
});

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (value: { currentSessionId: string }) => unknown) => (
    selector({ currentSessionId: 'session-1' })
  ),
}));

import { ToolCallDisplay } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay';

afterEach(cleanup);

// 台账/收件箱里持久化的是中文原句；英文 UI 按原句精确查表翻成英文。
const EN_CLOSURE_SENTENCES = {
  expiredAfterRestart24h: 'This step waited for your confirmation for over 24 hours, so it was voided automatically and did not run.',
  workingDirectoryUnavailable: "This conversation has no working directory, so it can't be run safely after a restart. It did not run.",
  runEndedAfterRestart: 'The run this step belonged to has already ended, so it did not run; you will be asked again the next time it triggers.',
  argsUnavailable: 'After the app restarted, the full details of this step could not be found, so it was not run for safety.',
} as const;

// 老行字面量（不经任何代码产出，模拟重启前落库的历史数据）。
const LEGACY_ZH_SENTENCES = {
  expiredAfterRestart24h: '这一步等你确认超过 24 小时，已自动作废，没有执行。',
  workingDirectoryUnavailable: '这次对话没有工作目录，重启后无法安全执行，没有执行。',
  runEndedAfterRestart: '所属运行已结束，没有执行；下次触发会重新询问你。',
  argsUnavailable: '应用重启后找不到这一步的完整信息，为安全起见没有执行。',
} as const;

type ClosureKey = keyof typeof LEGACY_ZH_SENTENCES;

function parkedToolCall(sentence: string): ToolCall {
  // 形状与 rejectLedgerToolApproval 写入台账的 result 一致：无 metadata。
  return {
    id: 'parked-1',
    name: 'Bash',
    arguments: { command: 'sleep 30' },
    result: { toolCallId: 'parked-1', success: false, error: sentence, duration: 0 },
  };
}

describe('ToolCallDisplay 停车审批收口结果', () => {
  describe.each([
    ['host 现写的收口句', (key: ClosureKey) => {
      if (key === 'expiredAfterRestart24h') return describeParkedApprovalClosure('expired_after_restart_24h');
      if (key === 'workingDirectoryUnavailable') return describeParkedApprovalClosure('args_unavailable', 'working_directory_unavailable');
      if (key === 'runEndedAfterRestart') return describeParkedApprovalClosure('run_ended_after_restart');
      return describeParkedApprovalClosure('args_unavailable');
    }],
    ['老行持久化的中文原句', (key: ClosureKey) => LEGACY_ZH_SENTENCES[key]],
  ] as const)('%s', (_label, sentence) => {
    it.each(Object.keys(LEGACY_ZH_SENTENCES) as ClosureKey[])('%s：折叠态直接读出「未执行 · 原句」', (key) => {
      languageState.value = 'zh';
      const view = render(<ToolCallDisplay toolCall={parkedToolCall(sentence(key))} index={0} total={1} />);
      const text = view.container.textContent ?? '';
      expect(text).toContain(`未执行 · ${LEGACY_ZH_SENTENCES[key]}`);
      expect(text).not.toMatch(/执行失败|暂无失败原因摘要|running|运行中/);
    });

    it.each(Object.keys(LEGACY_ZH_SENTENCES) as ClosureKey[])('%s：en UI 折叠态读出「Not run · 英文句」', (key) => {
      languageState.value = 'en';
      const view = render(<ToolCallDisplay toolCall={parkedToolCall(sentence(key))} index={0} total={1} />);
      const text = view.container.textContent ?? '';
      expect(text).toContain(`Not run · ${EN_CLOSURE_SENTENCES[key]}`);
      // 台账里的中文原句不再直接上英文 UI 的步骤头
      expect(text).not.toContain(LEGACY_ZH_SENTENCES[key]);
      expect(text).not.toMatch(/Execution failed|failure summary|running|运行中/);
    });
  });
});
