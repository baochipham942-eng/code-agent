import React from 'react';
import { createRoot } from 'react-dom/client';
import type { ElectronAPI } from '@shared/ipc';
import { EVALUATION_CHANNELS } from '@internal-evaluation/shared/evaluationChannels';
import type { EvalCaseListEntry, EvalCaseListItem } from '@shared/contract/evaluation';
import { EvalCenterPage } from '@internal-evaluation/renderer/evalCenter/EvalCenterPage';
import { useEvalCenterStore } from '@internal-evaluation/renderer/stores/evalCenterStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useAuthStore } from '../../../src/renderer/stores/authStore';
import '../../../src/renderer/styles/global.css';

type Theme = 'light' | 'dark';

const params = new URLSearchParams(window.location.search);
const theme = (params.get('theme') ?? 'dark') as Theme;
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
  {
    id: 'ppt-from-outline', file: '13-ppt-document-tests.yaml', relativeDir: '', layer: '产物任务',
    tags: ['ppt'], inheritedTags: ['artifact'], splits: ['held-out'],
    turns: 1, hasExpect: true, hardened: true, source: 'manual', retired: false, isDraft: false,
  },
  {
    id: 'user-simulator-recovery', file: 'user-simulator/recovery.yaml', relativeDir: 'user-simulator', layer: '专项：用户模拟器',
    tags: ['recovery'], inheritedTags: ['user-simulator'], splits: [],
    turns: 'simulator', hasExpect: true, hardened: true, source: 'manual', retired: false, isDraft: false,
  },
  {
    id: 'draft-report', file: 'drafts/draft-report.yaml', relativeDir: 'drafts', layer: '草稿',
    tags: ['report'], inheritedTags: [], splits: [], turns: 1, hasExpect: false,
    hardened: false, reviewStatus: 'pending', source: 'session', retired: false, isDraft: true,
  },
];

function generatedCase(index: number, special: boolean): EvalCaseListEntry {
  const specialDirectories = ['artifact-runnable', 'goal-contract', 'user-simulator'] as const;
  const relativeDir = special ? specialDirectories[index % specialDirectories.length] : '';
  const file = special
    ? `${relativeDir}/cases-${String(index + 1).padStart(2, '0')}.yaml`
    : `${String((index % 20) + 1).padStart(2, '0')}-case-suite.yaml`;
  return {
    id: `${special ? 'special' : 'case'}-${String(index + 1).padStart(3, '0')}`,
    file,
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

const defaultSamples = samples.filter((item) => item.relativeDir === '');
const specialSamples = samples.filter((item) => item.relativeDir !== '' && !item.isDraft);
const draftSamples = samples.filter((item) => item.isDraft);
const cases: EvalCaseListItem[] = [
  ...draftSamples,
  ...defaultSamples,
  ...Array.from({ length: 140 - defaultSamples.length }, (_, index) => generatedCase(index, false)),
  ...specialSamples,
  ...Array.from({ length: 13 - specialSamples.length }, (_, index) => generatedCase(index, true)),
];

const bridge = {
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

window.codeAgentAPI = bridge;
useAuthStore.setState({ user: { id: 'caselist-admin', email: 'admin@example.com', isAdmin: true } });
useAppStore.setState({ language: 'zh' });
useEvalCenterStore.setState({ tab: 'cases' });

createRoot(document.getElementById('root')!).render(<EvalCenterPage />);
