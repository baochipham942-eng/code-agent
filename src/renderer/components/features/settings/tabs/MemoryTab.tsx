// ============================================================================
// MemoryTab - Memory Management Settings Tab
// ============================================================================

import React, { useState, useEffect, useMemo } from 'react';
import {
  Search,
  Loader2,
  ChevronDown,
  ChevronRight,
  Download,
  Upload,
  Trash2,
  AlertCircle,
  CheckCircle,
  Plus,
} from 'lucide-react';
import { Button, Input } from '../../../primitives';
import { IPC_CHANNELS } from '@shared/ipc';
import { MemoryCard } from './MemoryCard';
import { MemoryEditModal } from './MemoryEditModal';
import { useI18n } from '../../../../hooks/useI18n';
import { createLogger } from '../../../../utils/logger';
import type { MemoryItem, MemoryCategory, MemoryStats } from '@shared/types';

const logger = createLogger('MemoryTab');

// Category info with icons
const CATEGORIES: Array<{
  key: MemoryCategory;
  icon: string;
  labelKey: string;
  descKey: string;
}> = [
  { key: 'about_me', icon: '👤', labelKey: 'aboutMe', descKey: 'aboutMeDesc' },
  { key: 'preference', icon: '⭐', labelKey: 'preference', descKey: 'preferenceDesc' },
  { key: 'frequent_info', icon: '📋', labelKey: 'frequentInfo', descKey: 'frequentInfoDesc' },
  { key: 'learned', icon: '💡', labelKey: 'learned', descKey: 'learnedDesc' },
];

// Category labels
const CATEGORY_LABELS: Record<MemoryCategory, string> = {
  about_me: '关于我',
  preference: '我的偏好',
  frequent_info: '常用信息',
  learned: '学到的经验',
};

// ============================================================================
// Component
// ============================================================================

export const MemoryTab: React.FC = () => {
  const { t } = useI18n();
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedCategories, setExpandedCategories] = useState<Set<MemoryCategory>>(
    new Set(['about_me', 'preference', 'frequent_info', 'learned'])
  );
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Edit modal state
  const [editingMemory, setEditingMemory] = useState<MemoryItem | null>(null);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);

  // Delete confirmation state
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [clearingCategory, setClearingCategory] = useState<MemoryCategory | null>(null);

  // Load memories
  const loadMemories = async () => {
    try {
      setIsLoading(true);
      const [memoriesResult, statsResult] = await Promise.all([
        window.electronAPI?.invoke(IPC_CHANNELS.MEMORY, { action: 'list' }) as Promise<{ success: boolean; data?: MemoryItem[] }>,
        window.electronAPI?.invoke(IPC_CHANNELS.MEMORY, { action: 'getStats' }) as Promise<{ success: boolean; data?: MemoryStats }>,
      ]);
      if (memoriesResult?.success && memoriesResult.data) {
        setMemories(memoriesResult.data);
      }
      if (statsResult?.success && statsResult.data) {
        setStats(statsResult.data);
      }
    } catch (error) {
      logger.error('Failed to load memories', error);
      setMessage({ type: 'error', text: '加载记忆失败' });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadMemories();
  }, []);

  // Auto-hide message after 3 seconds
  useEffect(() => {
    if (message) {
      const timer = setTimeout(() => setMessage(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  // Filter memories by search query
  const filteredMemories = useMemo(() => {
    if (!searchQuery.trim()) return memories;
    const query = searchQuery.toLowerCase();
    return memories.filter(
      (m) =>
        m.content.toLowerCase().includes(query) ||
        m.tags?.some((tag: string) => tag.toLowerCase().includes(query))
    );
  }, [memories, searchQuery]);

  // Group memories by category
  const memoriesByCategory = useMemo(() => {
    const grouped: Record<MemoryCategory, MemoryItem[]> = {
      about_me: [],
      preference: [],
      frequent_info: [],
      learned: [],
    };
    for (const memory of filteredMemories) {
      if (grouped[memory.category]) {
        grouped[memory.category].push(memory);
      }
    }
    return grouped;
  }, [filteredMemories]);

  // Toggle category expansion
  const toggleCategory = (category: MemoryCategory) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  };

  // Handle edit
  const handleEdit = (memory: MemoryItem) => {
    setEditingMemory(memory);
    setIsEditModalOpen(true);
  };

  // Handle save edit
  const handleSaveEdit = async (id: string, content: string) => {
    try {
      const result = await window.electronAPI?.invoke(IPC_CHANNELS.MEMORY, {
        action: 'update',
        id,
        content,
      });
      if (result?.success) {
        setMessage({ type: 'success', text: '记忆已更新' });
        await loadMemories();
      } else {
        setMessage({ type: 'error', text: result?.error || '更新失败' });
      }
    } catch (error) {
      logger.error('Failed to update memory', error);
      setMessage({ type: 'error', text: '更新失败' });
    }
    setIsEditModalOpen(false);
    setEditingMemory(null);
  };

  // Handle delete
  const handleDelete = async (id: string) => {
    try {
      const result = await window.electronAPI?.invoke(IPC_CHANNELS.MEMORY, {
        action: 'delete',
        id,
      });
      if (result?.success) {
        setMessage({ type: 'success', text: '记忆已删除' });
        await loadMemories();
      } else {
        setMessage({ type: 'error', text: result?.error || '删除失败' });
      }
    } catch (error) {
      logger.error('Failed to delete memory', error);
      setMessage({ type: 'error', text: '删除失败' });
    }
    setDeletingId(null);
  };

  // Handle clear category
  const handleClearCategory = async (category: MemoryCategory) => {
    try {
      const result = await window.electronAPI?.invoke(IPC_CHANNELS.MEMORY, {
        action: 'deleteByCategory',
        category,
      }) as { success: boolean; data?: { deleted: number }; error?: string } | undefined;
      if (result?.success) {
        setMessage({ type: 'success', text: `已清空 ${result.data?.deleted || 0} 条记忆` });
        await loadMemories();
      } else {
        setMessage({ type: 'error', text: result?.error || '清空失败' });
      }
    } catch (error) {
      logger.error('Failed to clear category', error);
      setMessage({ type: 'error', text: '清空失败' });
    }
    setClearingCategory(null);
  };

  // Handle export
  const handleExport = async () => {
    try {
      const result = await window.electronAPI?.invoke(IPC_CHANNELS.MEMORY, {
        action: 'export',
      });
      if (result?.success && result.data) {
        const blob = new Blob([JSON.stringify(result.data, null, 2)], {
          type: 'application/json',
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `memories-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        setMessage({ type: 'success', text: '导出成功' });
      } else {
        setMessage({ type: 'error', text: result?.error || '导出失败' });
      }
    } catch (error) {
      logger.error('Failed to export memories', error);
      setMessage({ type: 'error', text: '导出失败' });
    }
  };

  // Handle import
  const handleImport = async () => {
    try {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.onchange = async (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async (event) => {
          try {
            const data = JSON.parse(event.target?.result as string);
            const result = await window.electronAPI?.invoke(IPC_CHANNELS.MEMORY, {
              action: 'import',
              data,
            }) as { success: boolean; data?: { imported: number }; error?: string } | undefined;
            if (result?.success) {
              setMessage({ type: 'success', text: `导入成功: ${result.data?.imported || 0} 条` });
              await loadMemories();
            } else {
              setMessage({ type: 'error', text: result?.error || '导入失败' });
            }
          } catch {
            setMessage({ type: 'error', text: '无效的 JSON 文件' });
          }
        };
        reader.readAsText(file);
      };
      input.click();
    } catch (error) {
      logger.error('Failed to import memories', error);
      setMessage({ type: 'error', text: '导入失败' });
    }
  };

  // Loading state
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-zinc-400" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-medium text-zinc-100">记忆管理</h3>
          <p className="text-sm text-zinc-400 mt-0.5">
            AI 从对话中学习的知识和您定义的偏好
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleImport}
            className="flex items-center gap-1.5"
          >
            <Upload className="w-4 h-4" />
            导入
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleExport}
            className="flex items-center gap-1.5"
          >
            <Download className="w-4 h-4" />
            导出
          </Button>
        </div>
      </div>

      {/* Stats */}
      {stats && (
        <div className="flex items-center gap-4 px-3 py-2 bg-zinc-800/30 rounded-lg text-sm">
          <span className="text-zinc-400">
            共 <span className="text-zinc-200">{stats.total}</span> 条记忆
          </span>
          <span className="text-zinc-600">|</span>
          <span className="text-zinc-400">
            AI 学习 <span className="text-purple-400">{stats.learnedCount}</span>
          </span>
          <span className="text-zinc-400">
            用户定义 <span className="text-blue-400">{stats.explicitCount}</span>
          </span>
          {stats.recentlyAdded > 0 && (
            <>
              <span className="text-zinc-600">|</span>
              <span className="text-zinc-400">
                本周新增 <span className="text-green-400">{stats.recentlyAdded}</span>
              </span>
            </>
          )}
        </div>
      )}

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
        <Input
          type="text"
          placeholder="搜索记忆..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-9"
        />
      </div>

      {/* Message */}
      {message && (
        <div
          className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${
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
          {message.text}
        </div>
      )}

      {/* Categories */}
      <div className="space-y-3">
        {CATEGORIES.map((category) => {
          const categoryMemories = memoriesByCategory[category.key];
          const isExpanded = expandedCategories.has(category.key);
          const count = categoryMemories.length;

          return (
            <div key={category.key} className="border border-zinc-700/50 rounded-lg overflow-hidden">
              {/* Category header */}
              <button
                onClick={() => toggleCategory(category.key)}
                className="w-full flex items-center justify-between px-3 py-2.5 bg-zinc-800/30 hover:bg-zinc-800/50 transition-colors"
              >
                <div className="flex items-center gap-2">
                  {isExpanded ? (
                    <ChevronDown className="w-4 h-4 text-zinc-400" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-zinc-400" />
                  )}
                  <span className="text-lg">{category.icon}</span>
                  <span className="text-sm font-medium text-zinc-200">
                    {CATEGORY_LABELS[category.key]}
                  </span>
                  <span className="text-xs text-zinc-500">({count})</span>
                </div>

                {/* Category actions */}
                {count > 0 && (
                  <div
                    className="flex items-center gap-1"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {clearingCategory === category.key ? (
                      <>
                        <span className="text-xs text-red-400 mr-2">确认清空?</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleClearCategory(category.key)}
                          className="text-red-400 hover:bg-red-500/10 px-2 py-1 h-auto text-xs"
                        >
                          确认
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setClearingCategory(null)}
                          className="px-2 py-1 h-auto text-xs"
                        >
                          取消
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setClearingCategory(category.key)}
                        className="p-1 h-auto opacity-0 group-hover:opacity-100"
                        title="清空此分类"
                      >
                        <Trash2 className="w-3.5 h-3.5 text-zinc-500 hover:text-red-400" />
                      </Button>
                    )}
                  </div>
                )}
              </button>

              {/* Category content */}
              {isExpanded && (
                <div className="p-3 space-y-2">
                  {count === 0 ? (
                    <p className="text-sm text-zinc-500 text-center py-4">
                      暂无记忆
                    </p>
                  ) : (
                    categoryMemories.map((memory) => (
                      <MemoryCard
                        key={memory.id}
                        memory={memory}
                        onEdit={handleEdit}
                        onDelete={handleDelete}
                      />
                    ))
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Empty state */}
      {memories.length === 0 && (
        <div className="text-center py-12">
          <div className="text-4xl mb-3">🧠</div>
          <h4 className="text-zinc-200 font-medium mb-1">暂无记忆</h4>
          <p className="text-sm text-zinc-500">
            与 AI 对话后会自动学习，或手动添加您的偏好
          </p>
        </div>
      )}

      {/* Edit Modal */}
      <MemoryEditModal
        memory={editingMemory}
        isOpen={isEditModalOpen}
        onClose={() => {
          setIsEditModalOpen(false);
          setEditingMemory(null);
        }}
        onSave={handleSaveEdit}
      />
    </div>
  );
};
