import React from 'react';
import { createRoot } from 'react-dom/client';
import type { ElectronAPI } from '@shared/ipc';
import { EVALUATION_CHANNELS } from '@internal-evaluation/shared/evaluationChannels';
import type { EvalCaseListEntry, EvalCaseListItem } from '@shared/contract/evaluation';
import { EvalCenterPage } from '@internal-evaluation/renderer/evalCenter/EvalCenterPage';
import { useEvalCenterStore } from '@internal-evaluation/renderer/stores/evalCenterStore';
import { useAppStore } from '@renderer/stores/appStore';
import { useAuthStore } from '@renderer/stores/authStore';
import '@renderer/styles/global.css';

const params = new URLSearchParams(window.location.search);
const theme = params.get('theme') === 'light' ? 'light' : 'dark';
document.documentElement.dataset.theme = theme;
document.documentElement.className = theme;

const samples: EvalCaseListEntry[] = [
  {
    id: 'bash-pwd', file: '01-tool-tests.yaml', relativeDir: '', layer: '工具与任务基础',
    tags: ['shell'], inheritedTags: ['core-path', 'tool'], splits: ['held-in', 'control'],
    turns: 1, hasExpect: true, hardened: true, reviewStatus: 'reviewed', source: 'manual', retired: false, isDraft: false,
  },
  {
    id: 'multi-turn-correction', file: '03-conversation-tests.yaml', relativeDir: '', layer: '对话与多轮',
    tags: ['correction'], inheritedTags: ['conversation'], splits: ['held-out'],
    turns: 3, hasExpect: true, hardened: true, reviewStatus: 'reviewed', source: 'session', retired: false, isDraft: false,
  },
  {
    id: 'security-prompt-injection', file: '06-security-redline-tests.yaml', relativeDir: '', layer: '安全红线',
    tags: [], inheritedTags: ['security', 'redline'], splits: ['held-in', 'safety'],
    turns: 1, hasExpect: true, hardened: true, source: 'manual', retired: false, isDraft: false,
  },
];

function generatedCase(index: number, special: boolean): EvalCaseListEntry {
  const relativeDir = special ? 'user-simulator' : '';
  return {
    id: `${special ? 'special' : 'case'}-${String(index + 1).padStart(3, '0')}`,
    file: special ? `user-simulator/cases-${String(index + 1).padStart(2, '0')}.yaml` : `${String((index % 20) + 1).padStart(2, '0')}-case-suite.yaml`,
    relativeDir,
    layer: special ? '专项：产物可运行' : '工具与任务基础',
    tags: [],
    inheritedTags: [special ? 'special' : 'regression'],
    splits: special ? [] : index % 4 === 0 ? ['held-out'] : ['held-in'],
    turns: index % 9 === 0 ? 3 : 1,
    hasExpect: true,
    hardened: true,
    source: 'manual',
    retired: false,
    isDraft: false,
  };
}

const cases: EvalCaseListItem[] = [
  ...samples,
  ...Array.from({ length: 80 }, (_, index) => generatedCase(index, false)),
  ...Array.from({ length: 8 }, (_, index) => generatedCase(index, true)),
];

window.codeAgentAPI = {
  async invoke(channel: string, payload?: unknown): Promise<unknown> {
    if (channel === EVALUATION_CHANNELS.LIST_CASES) return cases;
    if (channel === EVALUATION_CHANNELS.SAVE_CASE) {
      const request = payload as { action: 'archive' | 'create-draft'; id: string };
      return { action: request.action, id: request.id, file: '01-tool-tests.yaml' };
    }
    return null;
  },
  on: () => () => undefined,
  off: () => undefined,
} as unknown as ElectronAPI;

useAuthStore.setState({ user: { id: 'caselist-admin', email: 'admin@example.com', isAdmin: true } });
useAppStore.setState({ language: 'zh' });
useEvalCenterStore.setState({ tab: 'cases' });

createRoot(document.getElementById('root')!).render(
  <div className="flex h-full min-h-0 flex-col">
    <EvalCenterPage />
  </div>,
);
