// ============================================================================
// ComboSkillCard - Combo Skill 录制建议卡片
// 当检测到可重复的工作流模式时，在输入框上方显示保存建议
// ============================================================================

import React, { useState } from 'react';
import { Sparkles, Save, X, Loader2 } from 'lucide-react';
import ipcService from '../../../../services/ipcService';

interface ComboSuggestion {
  sessionId: string;
  suggestedName: string;
  suggestedDescription: string;
  turnCount: number;
  stepCount: number;
  toolNames: string[];
}

interface ComboSkillCardProps {
  suggestion: ComboSuggestion;
  onDismiss: () => void;
  onSaved: () => void;
}

const invokeCombo = async <T,>(channel: string, ...args: unknown[]): Promise<T | undefined> => {
  return (ipcService.invoke as (...a: unknown[]) => Promise<T>)(channel, ...args);
};

export const ComboSkillCard: React.FC<ComboSkillCardProps> = ({
  suggestion,
  onDismiss,
  onSaved,
}) => {
  const [name, setName] = useState(suggestion.suggestedName);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const result = await invokeCombo<{ success: boolean; skillPath?: string }>(
        'skill:combo:save',
        suggestion.sessionId,
        name,
        suggestion.suggestedDescription,
      );
      if (result?.success) {
        onSaved();
      }
    } catch {
      // Silently fail
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="flex items-center gap-2 px-3 py-2 mb-2 bg-amber-500/10 border border-amber-500/20 rounded-lg animate-fadeIn">
      <Sparkles className="w-4 h-4 text-amber-400 flex-shrink-0" />

      <div className="flex-1 min-w-0">
        <div className="text-xs text-amber-300">
          检测到可复用的工作流（{suggestion.stepCount} 步 · {suggestion.toolNames.length} 工具）
        </div>
        {isEditing ? (
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => setIsEditing(false)}
            onKeyDown={(e) => e.key === 'Enter' && setIsEditing(false)}
            className="mt-1 w-full bg-zinc-800 border border-amber-500/30 rounded px-2 py-0.5 text-xs text-zinc-200 outline-none focus:border-amber-500/50"
            autoFocus
          />
        ) : (
          <button
            onClick={() => setIsEditing(true)}
            className="mt-0.5 text-xs text-amber-200/70 hover:text-amber-200 truncate block"
            title="点击修改名称"
          >
            保存为 &quot;{name}&quot;
          </button>
        )}
      </div>

      <button
        onClick={handleSave}
        disabled={isSaving || !name.trim()}
        className="flex items-center gap-1 px-2 py-1 text-xs bg-amber-500/20 text-amber-300 rounded hover:bg-amber-500/30 transition-colors disabled:opacity-50"
      >
        {isSaving ? (
          <Loader2 className="w-3 h-3 animate-spin" />
        ) : (
          <Save className="w-3 h-3" />
        )}
        保存
      </button>

      <button
        onClick={onDismiss}
        className="p-0.5 text-zinc-500 hover:text-zinc-300 transition-colors"
        title="忽略"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
};
