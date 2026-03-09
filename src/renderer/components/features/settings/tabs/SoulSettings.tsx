// ============================================================================
// SoulSettings - 人格 (PROFILE/SOUL) 编辑器
// ============================================================================

import React, { useState, useEffect } from 'react';
import { Save, Loader2, CheckCircle, AlertCircle } from 'lucide-react';
import { Button } from '../../../primitives';
import { createLogger } from '../../../../utils/logger';

const logger = createLogger('SoulSettings');

type SoulScope = 'project' | 'user';

export const SoulSettings: React.FC = () => {
  const [scope, setScope] = useState<SoulScope>('user');
  const [content, setContent] = useState('');
  const [filePath, setFilePath] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const loadProfile = async (s: SoulScope) => {
    setIsLoading(true);
    setMessage(null);
    try {
      const res = await window.domainAPI?.invoke<{ content: string; filePath: string }>(
        'soul', 'getProfile', { scope: s }
      );
      if (res?.data) {
        setContent(res.data.content || '');
        setFilePath(res.data.filePath || '');
      }
    } catch (error) {
      logger.error('Failed to load profile', error);
      setMessage({ type: 'error', text: '加载失败' });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadProfile(scope);
  }, [scope]);

  const handleSave = async () => {
    setIsSaving(true);
    setMessage(null);
    try {
      await window.domainAPI?.invoke('soul', 'saveProfile', { scope, content });
      setMessage({ type: 'success', text: '保存成功' });
      setTimeout(() => setMessage(null), 3000);
    } catch (error) {
      logger.error('Failed to save profile', error);
      setMessage({ type: 'error', text: '保存失败' });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h3 className="text-sm font-medium text-zinc-200 mb-2">人格设置</h3>
        <p className="text-xs text-zinc-400 mb-4">
          定义 Agent 的身份和行为风格。项目级 PROFILE.md 优先于用户级 SOUL.md。
        </p>
      </div>

      {/* Scope Toggle */}
      <div className="flex gap-2">
        <button
          onClick={() => setScope('project')}
          className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
            scope === 'project'
              ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30'
              : 'bg-zinc-700 text-zinc-400 border border-zinc-700 hover:text-zinc-200'
          }`}
        >
          项目级 PROFILE
        </button>
        <button
          onClick={() => setScope('user')}
          className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
            scope === 'user'
              ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'
              : 'bg-zinc-700 text-zinc-400 border border-zinc-700 hover:text-zinc-200'
          }`}
        >
          用户级 SOUL
        </button>
      </div>

      {/* File Path */}
      {filePath && (
        <div className="text-xs text-zinc-500 font-mono truncate" title={filePath}>
          {filePath}
        </div>
      )}

      {/* Editor */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-zinc-400" />
        </div>
      ) : (
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          className="w-full h-64 px-3 py-2 bg-zinc-700 border border-zinc-700 rounded-lg text-zinc-200 text-sm font-mono resize-y focus:outline-none focus:border-indigo-500"
          placeholder={scope === 'project'
            ? '# 项目人格\n\n定义此项目专用的 Agent 行为风格...'
            : '# 全局人格\n\n定义默认的 Agent 身份和行为风格...'
          }
        />
      )}

      {/* Save Button */}
      <div className="flex items-center gap-3">
        <Button
          onClick={handleSave}
          variant="primary"
          loading={isSaving}
          leftIcon={<Save className="w-4 h-4" />}
        >
          保存
        </Button>

        {message && (
          <div className={`flex items-center gap-1.5 text-xs ${
            message.type === 'success' ? 'text-green-400' : 'text-red-400'
          }`}>
            {message.type === 'success' ? <CheckCircle className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
            {message.text}
          </div>
        )}
      </div>

      {/* Help */}
      <div className="bg-zinc-800 rounded-lg p-4">
        <h4 className="text-sm font-medium text-zinc-200 mb-2">使用说明</h4>
        <div className="text-xs text-zinc-400 leading-relaxed space-y-2">
          <p><strong>PROFILE.md</strong> (项目级): 放在 <code className="text-indigo-400">.code-agent/PROFILE.md</code>，仅当前项目生效。</p>
          <p><strong>SOUL.md</strong> (用户级): 放在 <code className="text-indigo-400">~/.code-agent/SOUL.md</code>，所有项目的默认人格。</p>
          <p>优先级: 项目 PROFILE.md &gt; 用户 SOUL.md &gt; 内置默认。修改后自动热重载。</p>
        </div>
      </div>
    </div>
  );
};
