// ============================================================================
// CreateExperimentDialog - 新建实验对话框
// ============================================================================

import React, { useState, useEffect } from 'react';
import { Modal, ModalFooter } from '../../primitives';
import { IPC_CHANNELS, SUBSET_CHANNELS } from '@shared/ipc';

interface TestCaseInfo {
  id: string;
  name: string;
  description?: string;
}

interface TestSubsetInfo {
  name: string;
  description?: string;
  caseIds: string[];
  createdAt: number;
  fileName: string;
}

interface ExperimentConfig {
  name: string;
  model: string;
  testSetId: string;
  trialsPerCase: number;
  gitCommit: string;
}

interface CreateExperimentDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (config: ExperimentConfig) => Promise<void>;
}

const MODEL_OPTIONS = [
  { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
  { value: 'claude-haiku-35-20241022', label: 'Claude Haiku' },
  { value: 'kimi-k2', label: 'Kimi K2' },
  { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
];

export const CreateExperimentDialog: React.FC<CreateExperimentDialogProps> = ({
  isOpen,
  onClose,
  onSubmit,
}) => {
  const [name, setName] = useState(() => `exp_${Date.now()}`);
  const [model, setModel] = useState(MODEL_OPTIONS[0].value);
  const [testSetId, setTestSetId] = useState('');
  const [trialsPerCase, setTrialsPerCase] = useState(1);
  const [gitCommit, setGitCommit] = useState('auto-detect');
  const [testCases, setTestCases] = useState<TestCaseInfo[]>([]);
  const [testSubsets, setTestSubsets] = useState<TestSubsetInfo[]>([]);
  const [isLoadingCases, setIsLoadingCases] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Load test cases and subsets on open
  useEffect(() => {
    if (!isOpen) return;

    // Reset state each time dialog opens
    setName(`exp_${Date.now()}`);
    setSubmitError(null);
    setIsSubmitting(false);
    setTrialsPerCase(1);

    // Fetch available test cases and subsets in parallel
    const loadData = async () => {
      setIsLoadingCases(true);
      try {
        const [cases, subsets] = await Promise.all([
          window.electronAPI?.invoke(
            IPC_CHANNELS.EVALUATION_LIST_TEST_CASES
          ) as Promise<TestCaseInfo[] | undefined>,
          window.electronAPI?.invoke(
            SUBSET_CHANNELS.LIST as 'evaluation:list-test-subsets'
          ) as Promise<TestSubsetInfo[] | undefined>,
        ]);

        const suiteList = (cases && cases.length > 0) ? cases : [];
        const subsetList = (subsets && subsets.length > 0) ? subsets : [];

        setTestCases(suiteList);
        setTestSubsets(subsetList);

        // Default to first suite or subset
        if (suiteList.length > 0) {
          setTestSetId(suiteList[0].id);
        } else if (subsetList.length > 0) {
          setTestSetId(`subset:${subsetList[0].fileName}`);
        } else {
          setTestSetId('');
        }
      } catch {
        setTestCases([]);
        setTestSubsets([]);
        setTestSetId('');
      } finally {
        setIsLoadingCases(false);
      }
    };
    loadData();

    // Git commit will be auto-detected server-side in CREATE_EXPERIMENT handler
    setGitCommit('auto-detect');
  }, [isOpen]);

  const handleSubmit = async () => {
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      await onSubmit({
        name,
        model,
        testSetId,
        trialsPerCase,
        gitCommit,
      });
      onClose();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const selectClass =
    'w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 ' +
    'focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 ' +
    'appearance-none cursor-pointer';

  const inputClass =
    'w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 ' +
    'focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500';

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="新建实验"
      size="md"
      headerIcon={
        <div className="p-2 rounded-lg bg-indigo-500/10 text-indigo-400">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z"
            />
          </svg>
        </div>
      }
      footer={
        <ModalFooter
          cancelText="取消"
          confirmText={isSubmitting ? "创建中..." : "开始实验"}
          onCancel={onClose}
          onConfirm={handleSubmit}
          confirmColorClass="bg-indigo-600 hover:bg-indigo-500"
          confirmDisabled={!name.trim() || !testSetId || isSubmitting}
        />
      }
    >
      <div className="space-y-4">
        {/* Error message */}
        {submitError && (
          <div className="px-3 py-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg">
            {submitError}
          </div>
        )}

        {/* Experiment Name */}
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-zinc-400">
            实验名称
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="exp_1234567890"
            className={inputClass}
          />
        </div>

        {/* Model Selection */}
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-zinc-400">
            模型选择
          </label>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className={selectClass}
          >
            {MODEL_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        {/* Dataset Selection — suites + subsets */}
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-zinc-400">
            测试集
          </label>
          {isLoadingCases ? (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-zinc-500">
              <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              加载测试集...
            </div>
          ) : testCases.length === 0 && testSubsets.length === 0 ? (
            <div className="px-3 py-2 text-xs text-zinc-500 bg-zinc-800/50 rounded-lg border border-zinc-700/50">
              未找到测试集。请在{' '}
              <code className="bg-zinc-700 px-1 rounded text-zinc-300">
                .code-agent/test-cases/
              </code>{' '}
              目录下创建测试用例。
            </div>
          ) : (
            <select
              value={testSetId}
              onChange={(e) => setTestSetId(e.target.value)}
              className={selectClass}
            >
              {testCases.length > 0 && (
                <optgroup label="Suite (测试套件)">
                  {testCases.map((tc) => (
                    <option key={tc.id} value={tc.id}>
                      {tc.name || tc.id}
                    </option>
                  ))}
                </optgroup>
              )}
              {testSubsets.length > 0 && (
                <optgroup label="Subset (自定义子集)">
                  {testSubsets.map((s) => (
                    <option key={s.fileName} value={`subset:${s.fileName}`}>
                      {s.name} ({s.caseIds.length} cases)
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          )}
        </div>

        {/* Trials Per Case */}
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-zinc-400">
            每用例重复次数
          </label>
          <input
            type="number"
            min={1}
            max={5}
            value={trialsPerCase}
            onChange={(e) => {
              const v = Math.min(5, Math.max(1, parseInt(e.target.value) || 1));
              setTrialsPerCase(v);
            }}
            className={inputClass}
          />
          <p className="text-[10px] text-zinc-500">范围 1-5，用于评估 pass@k 稳定性</p>
        </div>

        {/* Git Commit */}
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-zinc-400">
            Git Commit
          </label>
          <div className="flex items-center gap-2 px-3 py-2 bg-zinc-800/50 rounded-lg border border-zinc-700/50">
            <svg className="w-3.5 h-3.5 text-zinc-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
            </svg>
            <span className="text-sm text-zinc-400 font-mono truncate">
              {gitCommit}
            </span>
          </div>
        </div>
      </div>
    </Modal>
  );
};
