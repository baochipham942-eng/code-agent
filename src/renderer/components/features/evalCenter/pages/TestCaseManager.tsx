import React, { useState, useEffect, useMemo } from 'react';
import { EVALUATION_CHANNELS } from '@shared/ipc/channels';

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

type FilterTag = 'all' | string;

export const TestCaseManager: React.FC = () => {
  const [suites, setSuites] = useState<TestSuite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTag, setActiveTag] = useState<FilterTag>('all');
  const [expandedSuites, setExpandedSuites] = useState<Set<string>>(new Set());

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

  const toggleSuite = (name: string) => {
    setExpandedSuites(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const getDifficultyColor = (d?: string) => {
    switch (d) {
      case 'easy': return 'text-emerald-400 bg-emerald-500/10';
      case 'medium': return 'text-amber-400 bg-amber-500/10';
      case 'hard': return 'text-red-400 bg-red-500/10';
      default: return 'text-zinc-400 bg-zinc-500/10';
    }
  };

  return (
    <div className="p-4 space-y-4">
      <h3 className="text-sm font-medium text-zinc-200">测试集管理</h3>

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
                      <div className="grid grid-cols-[1fr_80px_60px_60px] gap-2 px-3 py-1.5 text-[10px] text-zinc-500 uppercase bg-zinc-900/30">
                        <span>Case ID</span>
                        <span>类型</span>
                        <span>难度</span>
                        <span>状态</span>
                      </div>

                      {/* Cases */}
                      {suite.cases.map(tc => (
                        <div
                          key={tc.id}
                          className="grid grid-cols-[1fr_80px_60px_60px] gap-2 px-3 py-1.5 text-[11px] border-t border-zinc-700/10 hover:bg-zinc-800/30 transition"
                        >
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
    </div>
  );
};
