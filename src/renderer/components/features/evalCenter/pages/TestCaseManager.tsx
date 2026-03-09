import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { EVALUATION_CHANNELS, SUBSET_CHANNELS } from '@shared/ipc/channels';

interface TestCase {
  id: string;
  type: string;
  description: string;
  category?: string;
  difficulty?: string;
  tags?: string[];
  skip?: boolean;
}

interface TestSuite {
  name: string;
  description?: string;
  cases: TestCase[];
  tags?: string[];
  sourceDir?: string;
}

interface TestSubset {
  name: string;
  description?: string;
  caseIds: string[];
  createdAt: number;
  fileName: string;
}

type FilterTag = 'all' | string;
type TabView = 'suites' | 'subsets';

export const TestCaseManager: React.FC = () => {
  const [suites, setSuites] = useState<TestSuite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTag, setActiveTag] = useState<FilterTag>('all');
  const [expandedSuites, setExpandedSuites] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState<TabView>('suites');

  // Selection mode state
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedCaseIds, setSelectedCaseIds] = useState<Set<string>>(new Set());

  // Save subset dialog
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [subsetName, setSubsetName] = useState('');
  const [subsetDescription, setSubsetDescription] = useState('');
  const [saving, setSaving] = useState(false);

  // Subsets
  const [subsets, setSubsets] = useState<TestSubset[]>([]);
  const [loadingSubsets, setLoadingSubsets] = useState(false);
  const [expandedSubset, setExpandedSubset] = useState<string | null>(null);

  // Load test cases from backend
  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await window.electronAPI?.invoke(
          EVALUATION_CHANNELS.LIST_TEST_CASES as 'evaluation:list-test-cases'
        );
        if (data && Array.isArray(data)) {
          setSuites(data as TestSuite[]);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load test cases');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  // Load subsets
  const loadSubsets = useCallback(async () => {
    setLoadingSubsets(true);
    try {
      const data = await window.electronAPI?.invoke(
        SUBSET_CHANNELS.LIST as 'evaluation:list-test-subsets'
      );
      if (data && Array.isArray(data)) {
        setSubsets(data as TestSubset[]);
      }
    } catch {
      // ignore
    } finally {
      setLoadingSubsets(false);
    }
  }, []);

  useEffect(() => {
    loadSubsets();
  }, [loadSubsets]);

  // Collect all unique tags
  const allTags = useMemo(() => {
    const tags = new Set<string>();
    for (const suite of suites) {
      for (const tag of suite.tags || []) tags.add(tag);
      for (const tc of suite.cases) {
        for (const tag of tc.tags || []) tags.add(tag);
      }
    }
    return Array.from(tags).sort();
  }, [suites]);

  // Filter cases
  const filteredSuites = useMemo(() => {
    if (activeTag === 'all') return suites;
    return suites
      .map(suite => ({
        ...suite,
        cases: suite.cases.filter(tc => {
          const caseTags = [...(tc.tags || []), ...(suite.tags || [])];
          return caseTags.includes(activeTag);
        }),
      }))
      .filter(suite => suite.cases.length > 0);
  }, [suites, activeTag]);

  const totalCases = suites.reduce((sum, s) => sum + s.cases.length, 0);
  const filteredTotal = filteredSuites.reduce((sum, s) => sum + s.cases.length, 0);

  // Stats by difficulty
  const difficultyStats = useMemo(() => {
    const stats = { easy: 0, medium: 0, hard: 0, unknown: 0 };
    for (const suite of suites) {
      for (const tc of suite.cases) {
        const d = tc.difficulty as keyof typeof stats;
        if (d && d in stats) stats[d]++;
        else stats.unknown++;
      }
    }
    return stats;
  }, [suites]);

  // Stats by type
  const typeStats = useMemo(() => {
    const stats: Record<string, number> = {};
    for (const suite of suites) {
      for (const tc of suite.cases) {
        stats[tc.type] = (stats[tc.type] || 0) + 1;
      }
    }
    return Object.entries(stats).sort(([, a], [, b]) => b - a);
  }, [suites]);

  // All case IDs for select all
  const allVisibleCaseIds = useMemo(() => {
    const ids: string[] = [];
    for (const suite of filteredSuites) {
      for (const tc of suite.cases) {
        ids.push(tc.id);
      }
    }
    return ids;
  }, [filteredSuites]);

  const toggleSuite = (name: string) => {
    setExpandedSuites(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const toggleCaseSelection = (caseId: string) => {
    setSelectedCaseIds(prev => {
      const next = new Set(prev);
      if (next.has(caseId)) next.delete(caseId);
      else next.add(caseId);
      return next;
    });
  };

  const selectAll = () => {
    setSelectedCaseIds(new Set(allVisibleCaseIds));
  };

  const deselectAll = () => {
    setSelectedCaseIds(new Set());
  };

  const enterSelectionMode = () => {
    setSelectionMode(true);
    setSelectedCaseIds(new Set());
    // Expand all suites so user can see checkboxes
    setExpandedSuites(new Set(filteredSuites.map(s => s.name)));
  };

  const exitSelectionMode = () => {
    setSelectionMode(false);
    setSelectedCaseIds(new Set());
    setShowSaveDialog(false);
  };

  const handleSaveSubset = async () => {
    if (!subsetName.trim() || selectedCaseIds.size === 0) return;
    setSaving(true);
    try {
      await window.electronAPI?.invoke(
        SUBSET_CHANNELS.SAVE as 'evaluation:save-test-subset',
        {
          name: subsetName.trim(),
          description: subsetDescription.trim() || undefined,
          caseIds: Array.from(selectedCaseIds),
        }
      );
      setShowSaveDialog(false);
      setSubsetName('');
      setSubsetDescription('');
      exitSelectionMode();
      await loadSubsets();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save subset');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteSubset = async (fileName: string) => {
    try {
      await window.electronAPI?.invoke(
        SUBSET_CHANNELS.DELETE as 'evaluation:delete-test-subset',
        fileName
      );
      await loadSubsets();
    } catch {
      // ignore
    }
  };

  const getDifficultyColor = (d?: string) => {
    switch (d) {
      case 'easy': return 'text-emerald-400 bg-emerald-500/10';
      case 'medium': return 'text-amber-400 bg-amber-500/10';
      case 'hard': return 'text-red-400 bg-red-500/10';
      default: return 'text-zinc-400 bg-zinc-500/10';
    }
  };

  const formatDate = (ts: number) => {
    if (!ts) return '-';
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  };

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-zinc-200">测试集管理</h3>
        <div className="flex items-center gap-2">
          {selectionMode ? (
            <>
              <span className="text-[10px] text-indigo-400">
                已选 {selectedCaseIds.size} 个用例
              </span>
              <button
                onClick={selectAll}
                className="px-2 py-1 text-[10px] text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded transition"
              >
                全选
              </button>
              <button
                onClick={deselectAll}
                className="px-2 py-1 text-[10px] text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded transition"
              >
                取消全选
              </button>
              <button
                onClick={() => {
                  if (selectedCaseIds.size > 0) {
                    setSubsetName(`subset-${selectedCaseIds.size}`);
                    setShowSaveDialog(true);
                  }
                }}
                disabled={selectedCaseIds.size === 0}
                className="px-2 py-1 text-[10px] bg-indigo-600 hover:bg-indigo-500 text-white rounded transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                保存子集
              </button>
              <button
                onClick={exitSelectionMode}
                className="px-2 py-1 text-[10px] text-zinc-500 hover:text-zinc-300 transition"
              >
                取消
              </button>
            </>
          ) : (
            <button
              onClick={enterSelectionMode}
              className="px-2.5 py-1 text-[10px] text-indigo-400 hover:text-indigo-300 border border-indigo-500/30 hover:border-indigo-500/50 rounded transition"
            >
              + 创建子集
            </button>
          )}
        </div>
      </div>

      {/* Loading state */}
      {loading && (
        <div className="flex items-center justify-center py-12 gap-3">
          <svg className="animate-spin w-5 h-5 text-blue-400" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span className="text-sm text-zinc-500">加载测试用例...</span>
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
          <p className="text-xs text-red-400">{error}</p>
        </div>
      )}

      {/* Save Subset Dialog */}
      {showSaveDialog && (
        <div className="bg-zinc-800/80 border border-indigo-500/30 rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-200">保存测试子集</span>
            <span className="text-[10px] text-indigo-400">{selectedCaseIds.size} 个用例已选</span>
          </div>
          <div className="space-y-2">
            <input
              type="text"
              value={subsetName}
              onChange={(e) => setSubsetName(e.target.value)}
              placeholder="子集名称（如 smoke-6）"
              className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-1.5 text-xs text-zinc-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              autoFocus
            />
            <input
              type="text"
              value={subsetDescription}
              onChange={(e) => setSubsetDescription(e.target.value)}
              placeholder="描述（可选）"
              className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-1.5 text-xs text-zinc-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setShowSaveDialog(false)}
              className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition"
            >
              取消
            </button>
            <button
              onClick={handleSaveSubset}
              disabled={!subsetName.trim() || saving}
              className="px-3 py-1.5 text-xs bg-indigo-600 hover:bg-indigo-500 text-white rounded transition disabled:opacity-40"
            >
              {saving ? '保存中...' : '保存'}
            </button>
          </div>
        </div>
      )}

      {!loading && !error && (
        <>
          {/* Stats cards */}
          <div className="grid grid-cols-4 gap-3">
            <div className="bg-zinc-800/40 rounded-lg p-3 border border-zinc-700/30">
              <div className="text-lg font-bold text-blue-400">{totalCases}</div>
              <div className="text-[10px] text-zinc-500 mt-0.5">总用例数</div>
            </div>
            <div className="bg-zinc-800/40 rounded-lg p-3 border border-zinc-700/30">
              <div className="text-lg font-bold text-amber-400">{suites.length}</div>
              <div className="text-[10px] text-zinc-500 mt-0.5">测试套件</div>
            </div>
            <div className="bg-zinc-800/40 rounded-lg p-3 border border-zinc-700/30">
              <div className="text-lg font-bold text-emerald-400">{difficultyStats.easy}</div>
              <div className="text-[10px] text-zinc-500 mt-0.5">Easy</div>
            </div>
            <div className="bg-zinc-800/40 rounded-lg p-3 border border-zinc-700/30">
              <div className="text-lg font-bold text-red-400">{difficultyStats.hard}</div>
              <div className="text-[10px] text-zinc-500 mt-0.5">Hard</div>
            </div>
          </div>

          {/* Type distribution */}
          {typeStats.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              {typeStats.map(([type, count]) => (
                <span key={type} className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-800/60 text-zinc-400">
                  {type}: {count}
                </span>
              ))}
            </div>
          )}

          {/* Tab switcher */}
          <div className="flex gap-1 border-b border-zinc-700/30 pb-0">
            <button
              onClick={() => setActiveTab('suites')}
              className={`px-3 py-1.5 text-xs rounded-t transition border-b-2 ${
                activeTab === 'suites'
                  ? 'text-blue-400 border-blue-400'
                  : 'text-zinc-500 hover:text-zinc-300 border-transparent'
              }`}
            >
              测试套件 ({suites.length})
            </button>
            <button
              onClick={() => setActiveTab('subsets')}
              className={`px-3 py-1.5 text-xs rounded-t transition border-b-2 ${
                activeTab === 'subsets'
                  ? 'text-indigo-400 border-indigo-400'
                  : 'text-zinc-500 hover:text-zinc-300 border-transparent'
              }`}
            >
              子集 ({subsets.length})
            </button>
          </div>

          {activeTab === 'suites' && (
            <>
              {/* Tag filter tabs */}
              <div className="flex gap-1 flex-wrap">
                <button
                  onClick={() => setActiveTag('all')}
                  className={`px-3 py-1.5 text-xs rounded transition ${
                    activeTag === 'all'
                      ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                      : 'text-zinc-500 hover:text-zinc-300 border border-transparent'
                  }`}
                >
                  全部 ({totalCases})
                </button>
                {allTags.map(tag => (
                  <button
                    key={tag}
                    onClick={() => setActiveTag(tag)}
                    className={`px-3 py-1.5 text-xs rounded transition ${
                      activeTag === tag
                        ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                        : 'text-zinc-500 hover:text-zinc-300 border border-transparent'
                    }`}
                  >
                    {tag}
                  </button>
                ))}
              </div>

              {/* Suites with cases */}
              <div className="space-y-2">
                {filteredSuites.map(suite => {
                  const isExpanded = expandedSuites.has(suite.name);
                  return (
                    <div key={suite.name} className="bg-zinc-800/40 rounded-lg border border-zinc-700/30 overflow-hidden">
                      <button
                        onClick={() => toggleSuite(suite.name)}
                        className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-zinc-800/60 transition"
                      >
                        <svg
                          className={`w-3 h-3 text-zinc-500 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                          fill="none" stroke="currentColor" viewBox="0 0 24 24"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                        <span className="text-xs text-zinc-300 font-medium flex-1 truncate">
                          {suite.name}
                        </span>
                        <span className="text-[10px] text-zinc-500">
                          {suite.cases.length} cases
                        </span>
                        {suite.tags && suite.tags.length > 0 && (
                          <div className="flex gap-1">
                            {suite.tags.slice(0, 3).map(tag => (
                              <span key={tag} className="text-[9px] px-1.5 py-0.5 rounded-full bg-zinc-700/50 text-zinc-400">
                                {tag}
                              </span>
                            ))}
                          </div>
                        )}
                      </button>

                      {isExpanded && (
                        <div className="border-t border-zinc-700/30">
                          {/* Table header */}
                          <div className={`grid gap-2 px-3 py-1.5 text-[10px] text-zinc-500 uppercase bg-zinc-900/30 ${
                            selectionMode
                              ? 'grid-cols-[24px_1fr_80px_60px_60px]'
                              : 'grid-cols-[1fr_80px_60px_60px]'
                          }`}>
                            {selectionMode && <span></span>}
                            <span>Case ID</span>
                            <span>类型</span>
                            <span>难度</span>
                            <span>状态</span>
                          </div>

                          {/* Cases */}
                          {suite.cases.map(tc => (
                            <div
                              key={tc.id}
                              onClick={selectionMode ? () => toggleCaseSelection(tc.id) : undefined}
                              className={`grid gap-2 px-3 py-1.5 text-[11px] border-t border-zinc-700/10 transition ${
                                selectionMode
                                  ? 'grid-cols-[24px_1fr_80px_60px_60px] cursor-pointer hover:bg-indigo-500/5'
                                  : 'grid-cols-[1fr_80px_60px_60px] hover:bg-zinc-800/30'
                              } ${selectedCaseIds.has(tc.id) ? 'bg-indigo-500/10' : ''}`}
                            >
                              {selectionMode && (
                                <div className="flex items-center justify-center">
                                  <input
                                    type="checkbox"
                                    checked={selectedCaseIds.has(tc.id)}
                                    onChange={() => toggleCaseSelection(tc.id)}
                                    onClick={(e) => e.stopPropagation()}
                                    className="w-3 h-3 rounded border-zinc-600 text-indigo-500 bg-zinc-800 focus:ring-0 focus:ring-offset-0"
                                  />
                                </div>
                              )}
                              <div className="flex flex-col min-w-0">
                                <span className="text-zinc-300 font-mono truncate">{tc.id}</span>
                                <span className="text-[10px] text-zinc-500 truncate">{tc.description}</span>
                              </div>
                              <span className="text-zinc-400">{tc.type}</span>
                              <span className={`text-[10px] px-1.5 py-0.5 rounded-full w-fit ${getDifficultyColor(tc.difficulty)}`}>
                                {tc.difficulty || '-'}
                              </span>
                              <span className={`text-[10px] ${tc.skip ? 'text-zinc-600' : 'text-emerald-400'}`}>
                                {tc.skip ? 'skip' : 'active'}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Show filtered count */}
              {activeTag !== 'all' && (
                <div className="text-center py-2">
                  <span className="text-[10px] text-zinc-600 px-3 py-1 rounded-full bg-zinc-800/30">
                    筛选: {filteredTotal} / {totalCases} 用例
                  </span>
                </div>
              )}

              {/* Empty state */}
              {suites.length === 0 && (
                <div className="flex flex-col items-center justify-center py-12 text-zinc-500">
                  <p className="text-sm">未找到测试用例文件</p>
                  <p className="text-xs mt-1">请在 .claude/test-cases/ 目录下放置 YAML 测试用例</p>
                </div>
              )}
            </>
          )}

          {activeTab === 'subsets' && (
            <div className="space-y-2">
              {loadingSubsets ? (
                <div className="flex items-center justify-center py-8 gap-2">
                  <svg className="animate-spin w-4 h-4 text-indigo-400" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  <span className="text-xs text-zinc-500">加载子集...</span>
                </div>
              ) : subsets.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-zinc-500">
                  <svg className="w-8 h-8 mb-2 text-zinc-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                      d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                  </svg>
                  <p className="text-sm">暂无子集</p>
                  <p className="text-xs mt-1">在 "测试套件" 标签页中点击 "创建子集" 来选择用例</p>
                </div>
              ) : (
                subsets.map(subset => (
                  <div key={subset.fileName} className="bg-zinc-800/40 rounded-lg border border-zinc-700/30 overflow-hidden">
                    <div className="flex items-center gap-2 px-3 py-2.5">
                      <button
                        onClick={() => setExpandedSubset(expandedSubset === subset.fileName ? null : subset.fileName)}
                        className="flex items-center gap-2 flex-1 text-left hover:opacity-80 transition"
                      >
                        <svg
                          className={`w-3 h-3 text-indigo-400 transition-transform ${expandedSubset === subset.fileName ? 'rotate-90' : ''}`}
                          fill="none" stroke="currentColor" viewBox="0 0 24 24"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                        <span className="text-xs text-indigo-300 font-medium">{subset.name}</span>
                        <span className="text-[10px] text-zinc-500">{subset.caseIds.length} cases</span>
                      </button>
                      <span className="text-[10px] text-zinc-600">{formatDate(subset.createdAt)}</span>
                      <button
                        onClick={() => handleDeleteSubset(subset.fileName)}
                        className="text-zinc-600 hover:text-red-400 transition p-0.5"
                        title="删除子集"
                      >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                    {subset.description && (
                      <div className="px-3 pb-2 -mt-1">
                        <span className="text-[10px] text-zinc-500">{subset.description}</span>
                      </div>
                    )}
                    {expandedSubset === subset.fileName && (
                      <div className="border-t border-zinc-700/30 px-3 py-2 space-y-1">
                        {subset.caseIds.map(id => (
                          <div key={id} className="text-[11px] text-zinc-400 font-mono py-0.5 px-2 bg-zinc-900/30 rounded">
                            {id}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
};
