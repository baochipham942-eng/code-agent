// ============================================================================
// MemoryTab - Light Memory File Browser
// Displays memory files from ~/.code-agent/memory/ with session stats
// ============================================================================

import React, { useState, useEffect, useMemo } from 'react';
import {
  Search,
  Loader2,
  ChevronDown,
  ChevronRight,
  Trash2,
  FileText,
  Activity,
  MessageSquare,
  AlertCircle,
  CheckCircle,
  Brain,
} from 'lucide-react';
import { Input } from '../../../primitives';
import { IPC_CHANNELS } from '@shared/ipc';
import { isWebMode } from '../../../../utils/platform';
import { WebModeBanner } from '../WebModeBanner';
import ipcService from '../../../../services/ipcService';

// ============================================================================
// Types
// ============================================================================

interface LightMemoryFile {
  filename: string;
  name: string;
  description: string;
  type: string;
  content: string;
  updatedAt: string;
}

interface LightMemoryStats {
  totalFiles: number;
  byType: Record<string, number>;
  sessionStats: {
    activeDays: string[];
    totalSessions: number;
    recentSessionDepths: number[];
    modelUsage: Record<string, number>;
  } | null;
  recentConversations: string[];
}

// Memory type config
const TYPE_CONFIG: Record<string, { icon: string; label: string; color: string }> = {
  user: { icon: '👤', label: '用户', color: 'text-blue-400' },
  feedback: { icon: '💬', label: '反馈', color: 'text-amber-400' },
  project: { icon: '📁', label: '项目', color: 'text-green-400' },
  reference: { icon: '🔗', label: '引用', color: 'text-purple-400' },
  unknown: { icon: '📄', label: '未分类', color: 'text-zinc-400' },
};

// ============================================================================
// Component
// ============================================================================

export const MemoryTab: React.FC = () => {
  const [files, setFiles] = useState<LightMemoryFile[]>([]);
  const [stats, setStats] = useState<LightMemoryStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedTypes, setExpandedTypes] = useState<Set<string>>(new Set(['user', 'feedback', 'project', 'reference']));
  const [selectedFile, setSelectedFile] = useState<LightMemoryFile | null>(null);
  const [deletingFile, setDeletingFile] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [showConversations, setShowConversations] = useState(false);

  // Load data
  const loadData = async () => {
    try {
      setIsLoading(true);
      const [filesResult, statsResult] = await Promise.all([
        ipcService.invoke(IPC_CHANNELS.MEMORY, { action: 'lightList' }) as Promise<{ success: boolean; data?: LightMemoryFile[] }>,
        ipcService.invoke(IPC_CHANNELS.MEMORY, { action: 'lightStats' }) as Promise<{ success: boolean; data?: LightMemoryStats }>,
      ]);
      if (filesResult?.success && filesResult.data) {
        setFiles(filesResult.data);
      }
      if (statsResult?.success && statsResult.data) {
        setStats(statsResult.data);
      }
    } catch {
      setMessage({ type: 'error', text: '加载记忆失败' });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => { loadData(); }, []);

  // Auto-clear message
  useEffect(() => {
    if (message) {
      const timer = setTimeout(() => setMessage(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  // Filter files by search
  const filteredFiles = useMemo(() => {
    if (!searchQuery.trim()) return files;
    const q = searchQuery.toLowerCase();
    return files.filter(f =>
      f.name.toLowerCase().includes(q) ||
      f.description.toLowerCase().includes(q) ||
      f.content.toLowerCase().includes(q)
    );
  }, [files, searchQuery]);

  // Group files by type
  const filesByType = useMemo(() => {
    const grouped: Record<string, LightMemoryFile[]> = {};
    for (const f of filteredFiles) {
      const t = f.type || 'unknown';
      if (!grouped[t]) grouped[t] = [];
      grouped[t].push(f);
    }
    return grouped;
  }, [filteredFiles]);

  // Toggle type expansion
  const toggleType = (type: string) => {
    setExpandedTypes(prev => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  // Delete file
  const handleDelete = async (filename: string) => {
    try {
      const result = await ipcService.invoke(IPC_CHANNELS.MEMORY, {
        action: 'lightDelete',
        filename,
      }) as { success: boolean; data?: boolean };
      if (result?.success) {
        setMessage({ type: 'success', text: `已删除 ${filename}` });
        if (selectedFile?.filename === filename) setSelectedFile(null);
        await loadData();
      } else {
        setMessage({ type: 'error', text: '删除失败' });
      }
    } catch {
      setMessage({ type: 'error', text: '删除失败' });
    }
    setDeletingFile(null);
  };

  // Format relative date
  const formatDate = (iso: string) => {
    const date = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    if (diffDays === 0) return '今天';
    if (diffDays === 1) return '昨天';
    if (diffDays < 7) return `${diffDays}天前`;
    return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-48">
        <Loader2 className="w-6 h-6 animate-spin text-zinc-400" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <WebModeBanner />

      {/* Header */}
      <div className="flex items-center gap-2">
        <Brain className="w-5 h-5 text-indigo-400" />
        <div>
          <h3 className="text-sm font-medium text-zinc-200">Light Memory</h3>
          <p className="text-xs text-zinc-500">文件式记忆系统 · ~/.code-agent/memory/</p>
        </div>
      </div>

      {/* Session Stats */}
      {stats && (
        <div className="grid grid-cols-4 gap-2">
          <div className="bg-zinc-800 rounded-lg p-2 text-center">
            <div className="text-lg font-bold text-zinc-200">{stats.totalFiles}</div>
            <div className="text-xs text-zinc-400">记忆文件</div>
          </div>
          <div className="bg-zinc-800 rounded-lg p-2 text-center">
            <div className="text-lg font-bold text-indigo-400">
              {stats.sessionStats?.totalSessions ?? 0}
            </div>
            <div className="text-xs text-zinc-400">总会话</div>
          </div>
          <div className="bg-zinc-800 rounded-lg p-2 text-center">
            <div className="text-lg font-bold text-cyan-400">
              {stats.sessionStats ? (() => {
                const depths = stats.sessionStats.recentSessionDepths;
                return depths.length > 0
                  ? (depths.reduce((a, b) => a + b, 0) / depths.length).toFixed(0)
                  : '0';
              })() : '0'}
            </div>
            <div className="text-xs text-zinc-400">平均深度</div>
          </div>
          <div className="bg-zinc-800 rounded-lg p-2 text-center">
            <div className="text-lg font-bold text-amber-400">
              {stats.sessionStats ? (() => {
                const weekAgo = new Date();
                weekAgo.setDate(weekAgo.getDate() - 7);
                const weekAgoStr = weekAgo.toISOString().split('T')[0];
                return stats.sessionStats.activeDays.filter(d => d >= weekAgoStr).length;
              })() : 0}
            </div>
            <div className="text-xs text-zinc-400">7日活跃</div>
          </div>
        </div>
      )}

      {/* Model Usage */}
      {stats?.sessionStats?.modelUsage && Object.keys(stats.sessionStats.modelUsage).length > 0 && (
        <div className="bg-zinc-800 rounded-lg p-2">
          <div className="flex items-center gap-1.5 mb-1.5">
            <Activity className="w-3.5 h-3.5 text-zinc-400" />
            <span className="text-xs text-zinc-400">模型使用</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(stats.sessionStats.modelUsage)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 5)
              .map(([model, count]) => {
                const total = Object.values(stats.sessionStats!.modelUsage).reduce((a, b) => a + b, 0);
                const pct = Math.round((count / total) * 100);
                return (
                  <span key={model} className="px-2 py-0.5 text-xs bg-zinc-700 rounded text-zinc-300">
                    {model} <span className="text-zinc-500">{pct}%</span>
                  </span>
                );
              })}
          </div>
        </div>
      )}

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
        <Input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="搜索记忆文件..."
          className="pl-9"
        />
      </div>

      {/* Memory Files by Type */}
      <div className="space-y-2 max-h-[200px] overflow-y-auto">
        {Object.entries(filesByType).length === 0 ? (
          <div className="text-center py-6 text-zinc-500 text-sm">
            暂无记忆文件。AI 会在对话中自动创建记忆。
          </div>
        ) : (
          Object.entries(filesByType)
            .sort(([a], [b]) => {
              const order = ['user', 'feedback', 'project', 'reference', 'unknown'];
              return order.indexOf(a) - order.indexOf(b);
            })
            .map(([type, typeFiles]) => {
              const config = TYPE_CONFIG[type] || TYPE_CONFIG.unknown;
              const isExpanded = expandedTypes.has(type);

              return (
                <div key={type} className="bg-zinc-800 rounded-lg overflow-hidden">
                  <button
                    onClick={() => toggleType(type)}
                    className="w-full flex items-center gap-2 px-3 py-2 hover:bg-zinc-750 transition-colors"
                  >
                    {isExpanded ? (
                      <ChevronDown className="w-4 h-4 text-zinc-400" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-zinc-400" />
                    )}
                    <span className="text-base">{config.icon}</span>
                    <span className={`text-sm font-medium ${config.color} flex-1 text-left`}>
                      {config.label}
                    </span>
                    <span className="text-xs text-zinc-500">{typeFiles.length} 个</span>
                  </button>

                  {isExpanded && (
                    <div className="px-3 pb-2 space-y-1">
                      {typeFiles.map(file => (
                        <div
                          key={file.filename}
                          className={`group flex items-start gap-2 p-2 rounded-lg cursor-pointer transition-colors ${
                            selectedFile?.filename === file.filename
                              ? 'bg-indigo-500/10 border border-indigo-500/30'
                              : 'hover:bg-zinc-700'
                          }`}
                          onClick={() => setSelectedFile(
                            selectedFile?.filename === file.filename ? null : file
                          )}
                        >
                          <FileText className="w-4 h-4 text-zinc-500 mt-0.5 shrink-0" />
                          <div className="flex-1 min-w-0">
                            <div className="text-sm text-zinc-200 truncate">{file.name}</div>
                            <div className="text-xs text-zinc-500 truncate">{file.description}</div>
                            {selectedFile?.filename === file.filename && (
                              <div className="mt-2 text-xs text-zinc-300 whitespace-pre-wrap max-h-32 overflow-y-auto bg-zinc-800 rounded p-2">
                                {file.content || '(空)'}
                              </div>
                            )}
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <span className="text-xs text-zinc-600">{formatDate(file.updatedAt)}</span>
                            {deletingFile === file.filename ? (
                              <div className="flex gap-1">
                                <button
                                  onClick={(e) => { e.stopPropagation(); setDeletingFile(null); }}
                                  className="px-1.5 py-0.5 text-xs bg-zinc-600 rounded hover:bg-zinc-500"
                                >
                                  取消
                                </button>
                                <button
                                  onClick={(e) => { e.stopPropagation(); handleDelete(file.filename); }}
                                  className="px-1.5 py-0.5 text-xs bg-red-600 rounded hover:bg-red-500 text-white"
                                  disabled={isWebMode()}
                                >
                                  确认
                                </button>
                              </div>
                            ) : (
                              <button
                                onClick={(e) => { e.stopPropagation(); setDeletingFile(file.filename); }}
                                className="p-1 opacity-0 group-hover:opacity-100 hover:bg-zinc-600 rounded text-zinc-400 hover:text-red-400 transition-all"
                                title="删除"
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
        )}
      </div>

      {/* Recent Conversations */}
      {stats?.recentConversations && stats.recentConversations.length > 0 && (
        <div className="bg-zinc-800 rounded-lg overflow-hidden">
          <button
            onClick={() => setShowConversations(!showConversations)}
            className="w-full flex items-center gap-2 px-3 py-2 hover:bg-zinc-750 transition-colors"
          >
            {showConversations ? (
              <ChevronDown className="w-4 h-4 text-zinc-400" />
            ) : (
              <ChevronRight className="w-4 h-4 text-zinc-400" />
            )}
            <MessageSquare className="w-4 h-4 text-zinc-400" />
            <span className="text-sm font-medium text-zinc-300 flex-1 text-left">
              最近会话
            </span>
            <span className="text-xs text-zinc-500">{stats.recentConversations.length} 条</span>
          </button>
          {showConversations && (
            <div className="px-3 pb-2 space-y-0.5 max-h-32 overflow-y-auto">
              {stats.recentConversations.map((line, i) => (
                <div key={i} className="text-xs text-zinc-400 py-0.5">
                  {line.replace(/^- /, '')}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Message Toast */}
      {message && (
        <div
          className={`flex items-center gap-2 p-2 rounded-lg text-xs ${
            message.type === 'success'
              ? 'bg-green-500/10 text-green-400'
              : 'bg-red-500/10 text-red-400'
          }`}
        >
          {message.type === 'success' ? (
            <CheckCircle className="w-4 h-4" />
          ) : (
            <AlertCircle className="w-4 h-4" />
          )}
          <span>{message.text}</span>
        </div>
      )}
    </div>
  );
};
