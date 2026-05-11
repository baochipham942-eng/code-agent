// ============================================================================
// ChatInput - 消息输入组件主入口
// 支持多模态输入：文本、图片、代码、PDF、文件夹
// 深度研究通过语义自动检测触发，无需手动切换
// ============================================================================

import React, { useState, useRef, useCallback, useEffect, useImperativeHandle, forwardRef, useMemo } from 'react';
import { Image, FileText, Plus, GitBranch } from 'lucide-react';
import type { MessageAttachment } from '../../../../../shared/contract';
import type { ConversationEnvelope, RuntimeInputMode } from '@shared/contract/conversationEnvelope';
import { UI } from '@shared/constants';

import { InputArea, InputAreaRef } from './InputArea';
import { InputAddMenu } from './InputAddMenu';
import { AttachmentBar } from './AttachmentBar';
import { SendButton } from './SendButton';
import { SuggestionBar } from './SuggestionBar';
import { VoiceInputButton } from './VoiceInputButton';
import { PermissionToggle } from './PermissionToggle';
import { ContextUsagePill } from '../ContextUsagePill';
import { CostDisplay } from '../../../StatusBar/CostDisplay';
import { useStatusStore } from '../../../../stores/statusStore';
import { CommandPalette } from '../../../CommandPalette';
import { SlashCommandPopover } from './SlashCommandPopover';
import { useFileUpload } from './useFileUpload';
import { useFileAutocomplete } from '../../../../hooks/useFileAutocomplete';
import { useWorkbenchBrowserSession } from '../../../../hooks/useWorkbenchBrowserSession';
import { useSessionUIStore } from '../../../../stores/sessionUIStore';
import { useSessionStore } from '../../../../stores/sessionStore';
import { useComposerStore } from '../../../../stores/composerStore';
import { useSwarmStore } from '../../../../stores/swarmStore';
import { ComboSkillCard } from './ComboSkillCard';
import { useAppStore } from '../../../../stores/appStore';
import { ModelSwitcher } from '../../../StatusBar/ModelSwitcher';
import ipcService from '../../../../services/ipcService';
import { InlineWorkbenchBar } from '../InlineWorkbenchBar';
import {
  applyAgentMentionSuggestion,
  buildDirectRoutingPlaceholder,
  getLeadingAgentMentionAutocomplete,
  getPreferredAgentMentionToken,
  isLeadingAgentMentionInput,
  parseLeadingAgentMentions,
  syncLeadingAgentMentions,
} from './agentMentionRouting';
import { collectDroppedAttachments, shouldClearComposerAfterSend } from './utils';
import { buildBrowserSessionIntentSnapshot } from '../../../../utils/browserExecutionIntent';

// ============================================================================
// 类型定义
// ============================================================================

export interface ChatInputProps {
  onSend: (envelope: ConversationEnvelope) => boolean | Promise<boolean>;
  disabled?: boolean;
  /** 是否正在处理（用于显示停止按钮） */
  isProcessing?: boolean;
  /** 运行中补充指令正在接入 */
  isInterrupting?: boolean;
  /** 停止处理回调 */
  onStop?: () => void;
  /** 是否有 Plan */
  hasPlan?: boolean;
  /** 点击 Plan 入口 */
  onPlanClick?: () => void;
}

// Imperative handle exposed to parent (e.g. ChatView drop zone)
export interface ChatInputHandle {
  addAttachments: (items: MessageAttachment[]) => void;
  setDraft: (draft: { content: string; attachments?: MessageAttachment[] }) => void;
  focus: () => void;
}

// ============================================================================
// 主组件
// ============================================================================

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(({
  onSend,
  disabled,
  isProcessing,
  isInterrupting,
  onStop,
  hasPlan,
  onPlanClick,
}, ref) => {
  const [value, setValue] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [suggestions, setSuggestions] = useState<Array<{ id: string; text: string; source: string }>>([]);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [slashFilter, setSlashFilter] = useState('');
  const [showSlashPopover, setShowSlashPopover] = useState(false);
  const [selectedAgentMentionIndex, setSelectedAgentMentionIndex] = useState(0);
  const [dismissedAgentAutocompleteValue, setDismissedAgentAutocompleteValue] = useState<string | null>(null);
  const [runtimeInputMode, setRuntimeInputMode] = useState<RuntimeInputMode>('supplement');
  const [runtimeDraftStatus, setRuntimeDraftStatus] = useState<string | null>(null);
  const [comboSuggestion, setComboSuggestion] = useState<{
    sessionId: string;
    suggestedName: string;
    suggestedDescription: string;
    turnCount: number;
    stepCount: number;
    toolNames: string[];
  } | null>(null);
  const inputAreaRef = useRef<InputAreaRef>(null);
  const { processFile, processFolderEntry } = useFileUpload();
  const browserSession = useWorkbenchBrowserSession();
  const buildContext = useComposerStore((state) => state.buildContext);
  const routingMode = useComposerStore((state) => state.routingMode);
  const targetAgentIds = useComposerStore((state) => state.targetAgentIds);
  const hasMessages = useSessionStore((state) => state.messages.length > 0);
  const swarmAgents = useSwarmStore((state) => state.agents);
  const mentionPreview = useMemo(
    () => parseLeadingAgentMentions(value, swarmAgents),
    [swarmAgents, value],
  );
  const agentMentionAutocomplete = useMemo(
    () => getLeadingAgentMentionAutocomplete(value, swarmAgents),
    [swarmAgents, value],
  );
  const isAgentMentionAutocompleteOpen = Boolean(
    agentMentionAutocomplete
    && agentMentionAutocomplete.matches.length > 0
    && dismissedAgentAutocompleteValue !== value,
  );
  const selectedDirectAgents = useMemo(
    () => swarmAgents.filter((agent) => targetAgentIds.includes(agent.id)),
    [swarmAgents, targetAgentIds],
  );
  const inputPlaceholder = useMemo(() => {
    if (routingMode === 'direct') {
      return buildDirectRoutingPlaceholder(selectedDirectAgents, swarmAgents);
    }
    return undefined;
  }, [routingMode, selectedDirectAgents, swarmAgents]);

  const buildEnvelope = useCallback((
    rawContent: string,
    nextAttachments?: MessageAttachment[],
    nextRuntimeInputMode?: RuntimeInputMode,
  ): ConversationEnvelope => {
    const parsedMentions = parseLeadingAgentMentions(rawContent, swarmAgents);
    const content = parsedMentions ? parsedMentions.content : rawContent.trim();
    const baseContext = buildContext();
    const nextContext = parsedMentions
      ? {
          ...baseContext,
          routing: {
            mode: 'direct' as const,
            targetAgentIds: parsedMentions.targetAgentIds,
          },
        }
      : baseContext;
    const browserSessionMode = nextContext?.executionIntent?.browserSessionMode;
    const context = browserSessionMode
      ? {
          ...nextContext,
          executionIntent: {
            ...nextContext.executionIntent,
            browserSessionSnapshot: buildBrowserSessionIntentSnapshot({
              mode: browserSessionMode,
              browserSession,
            }),
          },
        }
      : nextContext;
    const runtimeScopedContext = nextRuntimeInputMode
      ? {
          ...context,
          runtimeInput: {
            mode: nextRuntimeInputMode,
          },
        }
      : context;

    return {
      content,
      attachments: nextAttachments && nextAttachments.length > 0 ? nextAttachments : undefined,
      context: runtimeScopedContext,
    };
  }, [browserSession, buildContext, swarmAgents]);

  // Expose addAttachments to parent via ref (for global drop zone)
  useImperativeHandle(ref, () => ({
    addAttachments: (items: MessageAttachment[]) => {
      if (items.length > 0) {
        setAttachments((prev) => [...prev, ...items].slice(0, UI.MAX_ATTACHMENTS_DROP));
      }
    },
    setDraft: (draft) => {
      setValue(draft.content);
      setAttachments((draft.attachments ?? []).slice(0, UI.MAX_ATTACHMENTS_DROP));
      setRuntimeDraftStatus(null);
      inputAreaRef.current?.focus();
    },
    focus: () => {
      inputAreaRef.current?.focus();
    },
  }), []);

  // Listen for context-aware suggestions from agent (pushed after each turn)
  useEffect(() => {
    const unsubscribe = ipcService.on('agent:event', (event: { type: string; data: unknown }) => {
      if (event.type === 'suggestions_update' && Array.isArray(event.data)) {
        setSuggestions(event.data as Array<{ id: string; text: string; source: string }>);
      }
      // Combo Skill suggestion from backend
      if (event.type === 'combo_skill_suggestion' && event.data) {
        setComboSuggestion(event.data as typeof comboSuggestion);
      }
    });
    return () => { unsubscribe?.(); };
  }, []);

  // IACT protocol: listen for inline interaction events from message bubbles
  useEffect(() => {
    const handleSend = (e: Event) => {
      const text = (e as CustomEvent<string>).detail;
      if (text?.trim()) {
        void onSend(buildEnvelope(text));
      }
    };
    const handleAdd = (e: Event) => {
      const text = (e as CustomEvent<string>).detail;
      if (text?.trim()) {
        setValue(prev => prev.trim() ? `${prev} ${text}` : text);
        inputAreaRef.current?.focus();
      }
    };
    const handleRun = (e: Event) => {
      const cmd = (e as CustomEvent<string>).detail;
      if (cmd?.trim()) {
        void onSend(buildEnvelope(`Execute this shell command and show the output: \`${cmd.trim()}\``));
      }
    };
    window.addEventListener('iact:send', handleSend);
    window.addEventListener('iact:add', handleAdd);
    window.addEventListener('iact:run', handleRun);
    return () => {
      window.removeEventListener('iact:send', handleSend);
      window.removeEventListener('iact:add', handleAdd);
      window.removeEventListener('iact:run', handleRun);
    };
  }, [buildEnvelope, onSend]);

  // Clear suggestions when user starts typing
  useEffect(() => {
    if (value.trim().length > 0) {
      setSuggestions([]);
    }
  }, [value]);

  useEffect(() => {
    setSelectedAgentMentionIndex(0);
    if (dismissedAgentAutocompleteValue && dismissedAgentAutocompleteValue !== value) {
      setDismissedAgentAutocompleteValue(null);
    }
  }, [agentMentionAutocomplete?.query, agentMentionAutocomplete?.matches.length, dismissedAgentAutocompleteValue, value]);

  // Handle suggestion selection
  const handleSuggestionSelect = useCallback((text: string) => {
    setValue(text);
    inputAreaRef.current?.focus();
  }, []);

  // @ file autocomplete
  const { matches: fileMatches, isOpen: isAutocompleteOpen, query: atQuery, search: searchFiles, dismiss: dismissAutocomplete } = useFileAutocomplete();

  // Track input changes for @ autocomplete and / command palette
  const handleValueChange = useCallback((newValue: string) => {
    setValue(newValue);
    setRuntimeDraftStatus(null);
    // Detect / prefix to show inline slash command popover
    if (newValue.startsWith('/')) {
      setShowSlashPopover(true);
      setSlashFilter(newValue.slice(1));
      return;
    } else {
      setShowSlashPopover(false);
    }
    if (isLeadingAgentMentionInput(newValue, swarmAgents)) {
      dismissAutocomplete();
      return;
    }
    // Check for @ pattern at cursor position (approximate: end of string)
    searchFiles(newValue, newValue.length);
  }, [dismissAutocomplete, searchFiles, swarmAgents]);

  // Handle @ file selection
  const handleFileSelect_autocomplete = useCallback((filePath: string) => {
    // Replace @query with the file path
    const beforeAt = value.replace(new RegExp(`@${atQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), '');
    setValue(beforeAt + '@' + filePath + ' ');
    dismissAutocomplete();
    inputAreaRef.current?.focus();
  }, [value, atQuery, dismissAutocomplete]);

  const handleAgentMentionSelect = useCallback((agentId: string) => {
    const agent = swarmAgents.find((item) => item.id === agentId);
    if (!agent) return;
    setValue((prev) => applyAgentMentionSuggestion(prev, agent));
    setDismissedAgentAutocompleteValue(null);
    inputAreaRef.current?.focus();
  }, [swarmAgents]);

  const handleDirectTargetIdsChange = useCallback((nextTargetAgentIds: string[]) => {
    const nextAgents = swarmAgents.filter((agent) => nextTargetAgentIds.includes(agent.id));
    setValue((prev) => syncLeadingAgentMentions(prev, nextAgents, swarmAgents));
    setDismissedAgentAutocompleteValue(null);
    inputAreaRef.current?.focus();
  }, [swarmAgents]);

  const handleAutocompleteKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!isAgentMentionAutocompleteOpen || !agentMentionAutocomplete) {
      return false;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedAgentMentionIndex((prev) => (prev + 1) % agentMentionAutocomplete.matches.length);
      return true;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedAgentMentionIndex((prev) => (
        prev === 0 ? agentMentionAutocomplete.matches.length - 1 : prev - 1
      ));
      return true;
    }

    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      const selected = agentMentionAutocomplete.matches[selectedAgentMentionIndex];
      if (selected) {
        e.preventDefault();
        handleAgentMentionSelect(selected.id);
        return true;
      }
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      setDismissedAgentAutocompleteValue(value);
      return true;
    }

    return false;
  }, [
    agentMentionAutocomplete,
    handleAgentMentionSelect,
    isAgentMentionAutocompleteOpen,
    selectedAgentMentionIndex,
    value,
  ]);

  // 历史命令功能
  const {
    addToInputHistory,
    getPreviousInput,
    getNextInput,
    resetInputHistoryIndex,
  } = useSessionUIStore();

  const resolvedPlaceholder = useMemo(() => {
    if (inputPlaceholder) return inputPlaceholder;
    if (!isProcessing) return undefined;
    return runtimeInputMode === 'redirect'
      ? '改道：按这条重新处理...'
      : '补充当前任务...';
  }, [inputPlaceholder, isProcessing, runtimeInputMode]);

  useEffect(() => {
    if (!isProcessing) {
      setRuntimeInputMode('supplement');
      setRuntimeDraftStatus(null);
    }
  }, [isProcessing]);

  // 处理提交
  // 运行中允许提交，把新输入作为补充指令交给当前任务。
  // P3-18: ! prefix executes shell command directly
  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const trimmedValue = value.trim();
    const activeRuntimeInputMode = isProcessing ? runtimeInputMode : undefined;
    const nextEnvelope = buildEnvelope(trimmedValue, attachments, activeRuntimeInputMode);
    const canSubmit = ((nextEnvelope.content.trim().length > 0) || attachments.length > 0) && (!disabled || isProcessing) && !isUploading;
    if (canSubmit) {
      setRuntimeDraftStatus(null);
      // 添加到输入历史
      if (trimmedValue) {
        addToInputHistory(trimmedValue);
      }
      // P3-18: Shell shortcut - ! prefix sends command to agent as bash request
      if (nextEnvelope.content.startsWith('!')) {
        const shellCmd = nextEnvelope.content.slice(1).trim();
        if (shellCmd) {
          try {
            const sent = await onSend({
              content: `Execute this shell command and show the output: \`${shellCmd}\``,
              context: nextEnvelope.context,
            });
            if (!shouldClearComposerAfterSend(sent)) {
              inputAreaRef.current?.focus();
              return;
            }
          } catch {
            if (isProcessing) {
              setRuntimeDraftStatus(runtimeInputMode === 'redirect'
                ? '改道没发出去，草稿已保留'
                : '当前任务还没准备好，草稿已保留');
            }
            inputAreaRef.current?.focus();
            return;
          }
        }
      } else {
        try {
          const sent = await onSend(nextEnvelope);
          if (!shouldClearComposerAfterSend(sent)) {
            inputAreaRef.current?.focus();
            return;
          }
        } catch {
          if (isProcessing) {
            setRuntimeDraftStatus(runtimeInputMode === 'redirect'
              ? '改道没发出去，草稿已保留'
              : '当前任务还没准备好，草稿已保留');
          }
          inputAreaRef.current?.focus();
          return;
        }
      }
      setValue('');
      setAttachments([]);
      setRuntimeInputMode('supplement');
    }
  };

  // 处理文件选择
  const handleFileSelect = async (files: FileList) => {
    setIsUploading(true);
    try {
      const newAttachments: MessageAttachment[] = [];
      for (const file of Array.from(files)) {
        const attachment = await processFile(file);
        if (attachment) newAttachments.push(attachment);
      }
      if (newAttachments.length > 0) {
        setAttachments((prev) => [...prev, ...newAttachments].slice(0, UI.MAX_ATTACHMENTS_FILE_SELECT));
      }
    } finally {
      setIsUploading(false);
    }
  };

  // 处理图片粘贴（如微信截图）
  const handleImagePaste = useCallback(async (file: File) => {
    setIsUploading(true);
    try {
      const attachment = await processFile(file);
      if (attachment) {
        setAttachments((prev) => [...prev, attachment].slice(0, UI.MAX_ATTACHMENTS_FILE_SELECT));
      }
    } finally {
      setIsUploading(false);
    }
  }, [processFile]);

  // 拖放处理
  const clearDragState = useCallback(() => {
    setIsDragOver(false);
  }, []);

  useEffect(() => {
    if (!isDragOver) return;
    window.addEventListener('dragend', clearDragState);
    window.addEventListener('drop', clearDragState);
    window.addEventListener('blur', clearDragState);
    return () => {
      window.removeEventListener('dragend', clearDragState);
      window.removeEventListener('drop', clearDragState);
      window.removeEventListener('blur', clearDragState);
    };
  }, [clearDragState, isDragOver]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    setIsUploading(true);

    try {
      const newAttachments = await collectDroppedAttachments(e.dataTransfer, processFile, processFolderEntry);

      if (newAttachments.length > 0) {
        setAttachments((prev) => [...prev, ...newAttachments].slice(0, UI.MAX_ATTACHMENTS_DROP));
      }
    } finally {
      setIsUploading(false);
    }
  }, [processFile, processFolderEntry]);

  // 移除附件
  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  // 语音输入回调 - 追加到现有文本
  const handleVoiceTranscript = useCallback((text: string) => {
    if (text.trim()) {
      setValue(prev => prev.trim() ? `${prev} ${text}` : text);
      // 聚焦输入框
      inputAreaRef.current?.focus();
    }
  }, []);

  const modelConfig = useAppStore((s) => s.modelConfig);
  const sessionCost = useStatusStore((s) => s.sessionCost);
  const statusStreaming = useStatusStore((s) => s.isStreaming);
  const hasContent = value.trim().length > 0 || attachments.length > 0;

  return (
    <div
      className={`px-4 pb-4 pt-2 transition-colors ${isDragOver ? 'bg-primary-500/5' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Command Palette triggered by / */}
      <CommandPalette isOpen={showCommandPalette} onClose={() => setShowCommandPalette(false)} />
      <form onSubmit={handleSubmit} className="max-w-3xl mx-auto">
        <InlineWorkbenchBar
          previewTargetAgentIds={mentionPreview?.targetAgentIds}
          onDirectTargetIdsChange={handleDirectTargetIdsChange}
        />

        {/* Plan 入口按钮 - 仅当有 Plan 时显示 */}
        {hasPlan && onPlanClick && (
          <button
            type="button"
            onClick={onPlanClick}
            className="flex items-center gap-2 px-3 py-2 mb-2 bg-indigo-500/10 border border-indigo-500/20 rounded-lg hover:bg-indigo-500/20 transition-colors w-full text-left"
          >
            <FileText className="w-4 h-4 text-indigo-400" />
            <span className="text-sm text-indigo-400">查看实现计划</span>
          </button>
        )}

        {/* 文件处理中提示 */}
        {isUploading && (
          <div className="flex items-center gap-2 px-3 py-2 mb-2 bg-amber-500/10 border border-amber-500/20 rounded-lg">
            <div className="w-4 h-4 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-amber-400">文件处理中...</span>
          </div>
        )}

        {/* 附件预览区 */}
        {attachments.length > 0 && (
          <div className="mb-2">
            <AttachmentBar attachments={attachments} onRemove={removeAttachment} />
          </div>
        )}

        {/* 拖放提示 */}
        {isDragOver && (
          <div className="absolute inset-0 flex items-center justify-center bg-zinc-800-950/90 backdrop-blur-sm z-10 rounded-xl border-2 border-dashed border-primary-500">
            <div className="flex flex-col items-center gap-2 text-primary-400">
              <Image className="w-8 h-8" />
              <span className="text-sm">拖放文件或文件夹到这里</span>
            </div>
          </div>
        )}

        {/* Combo Skill suggestion card */}
        {comboSuggestion && (
          <ComboSkillCard
            suggestion={comboSuggestion}
            onDismiss={() => setComboSuggestion(null)}
            onSaved={() => setComboSuggestion(null)}
          />
        )}

        {/* Suggestion Bar - show when input is empty */}
        {value.trim().length === 0 && suggestions.length > 0 && (
          <SuggestionBar suggestions={suggestions} onSelect={handleSuggestionSelect} />
        )}

        {/* Codex 风格融合：去掉明显边框 + 阴影，只用极弱 bg 区分输入区跟聊天内容 */}
        <div className="relative bg-white/[0.02] backdrop-blur-sm rounded-2xl focus-within:bg-white/[0.04] transition-colors duration-200">
          {/* Slash command inline popover */}
          <SlashCommandPopover
            isOpen={showSlashPopover}
            filter={slashFilter}
            onClose={() => { setShowSlashPopover(false); setValue(''); }}
            onSelect={(cmd) => {
              setShowSlashPopover(false);
              setValue('');
              cmd.action();
            }}
          />
          {/* @ File autocomplete dropdown */}
          {isAgentMentionAutocompleteOpen && agentMentionAutocomplete && (
            <div className="absolute bottom-full left-0 right-0 mb-1 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl z-20 max-h-[240px] overflow-y-auto">
              {agentMentionAutocomplete.matches.map((agent, index) => {
                const agentRole = (agent as { role?: string }).role;
                return (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => handleAgentMentionSelect(agent.id)}
                    className={`w-full px-3 py-2 text-left transition-colors ${
                      index === selectedAgentMentionIndex
                        ? 'bg-zinc-700'
                        : 'hover:bg-zinc-800'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-zinc-200">@{getPreferredAgentMentionToken(agent)}</span>
                      <span className="text-xs text-zinc-500 truncate">{agent.name}</span>
                      {agentRole ? (
                        <span className="ml-auto text-[11px] text-zinc-600 truncate">{agentRole}</span>
                      ) : null}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
          {(!isAgentMentionAutocompleteOpen && isAutocompleteOpen && fileMatches.length > 0) && (
            <div className="absolute bottom-full left-0 right-0 mb-1 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl z-20 max-h-[200px] overflow-y-auto">
              {fileMatches.map((f, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => handleFileSelect_autocomplete(f.path)}
                  className="w-full px-3 py-1.5 text-left text-sm text-zinc-400 hover:bg-zinc-700 transition-colors font-mono truncate"
                >
                  {f.name}
                </button>
              ))}
            </div>
          )}
          <InputArea
            ref={inputAreaRef}
            value={value}
            onChange={handleValueChange}
            onSubmit={handleSubmit}
            onFileSelect={handleFileSelect}
            onImagePaste={handleImagePaste}
            disabled={disabled && !isProcessing}
            hasAttachments={attachments.length > 0}
            hasMessages={hasMessages}
            isFocused={isFocused}
            onFocusChange={setIsFocused}
            placeholder={resolvedPlaceholder}
            onHistoryPrev={getPreviousInput}
            onHistoryNext={getNextInput}
            onHistoryReset={resetInputHistoryIndex}
            onAutocompleteKeyDown={handleAutocompleteKeyDown}
          />
          {isProcessing && hasContent && !isInterrupting && (
            <div className="px-4 pb-2 -mt-1 flex flex-wrap items-center gap-2">
              <div className="inline-flex items-center gap-1 rounded-lg bg-white/[0.04] p-0.5">
                <button
                  type="button"
                  onClick={() => {
                    setRuntimeInputMode('supplement');
                    setRuntimeDraftStatus(null);
                  }}
                  className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition-colors ${
                    runtimeInputMode === 'supplement'
                      ? 'bg-zinc-100 text-zinc-950'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                  aria-pressed={runtimeInputMode === 'supplement'}
                  title="加入当前任务，不改变整体方向"
                >
                  <Plus className="h-3 w-3" />
                  <span>补充</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRuntimeInputMode('redirect');
                    setRuntimeDraftStatus(null);
                  }}
                  className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition-colors ${
                    runtimeInputMode === 'redirect'
                      ? 'bg-amber-400 text-zinc-950'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                  aria-pressed={runtimeInputMode === 'redirect'}
                  title="停止当前思路，按这条重新处理"
                >
                  <GitBranch className="h-3 w-3" />
                  <span>改道</span>
                </button>
              </div>
              <div className="inline-flex max-w-full items-center gap-2 rounded-lg bg-white/[0.04] px-2.5 py-1 text-[11px] text-zinc-400">
                <span className={`h-1.5 w-1.5 rounded-full ${
                  runtimeDraftStatus
                    ? 'bg-amber-300'
                    : runtimeInputMode === 'redirect'
                      ? 'bg-amber-300'
                      : 'bg-emerald-400'
                }`} />
                <span className="truncate">
                  {runtimeDraftStatus || (
                    runtimeInputMode === 'redirect'
                      ? '将停止当前思路并按这条改道'
                      : '将加入当前任务，不打断整体方向'
                  )}
                </span>
                {runtimeDraftStatus && (
                  <button
                    type="button"
                    onClick={() => {
                      setRuntimeDraftStatus(null);
                      setValue('');
                      setAttachments([]);
                    }}
                    className="ml-1 text-zinc-500 hover:text-zinc-200"
                    title="清除这条草稿"
                  >
                    取消
                  </button>
                )}
              </div>
            </div>
          )}
          {/* 底部工具栏 */}
          <div className="flex items-center gap-1 px-3 pb-3">
            {/* "+" 二级菜单（Codex 风格 B+）— 收纳 /命令 + 上传附件 + 交互模式 */}
            <InputAddMenu
              onSlashCommand={() => { setShowSlashPopover(true); setSlashFilter(''); }}
              onFileSelect={handleFileSelect}
            />

            {/* 权限模式 chip — Default / Full Access（高频，保留独立位置） */}
            <PermissionToggle disabled={disabled && !isProcessing} />

            {/* B+ 移除: AbilityMenu (Routing/Browser/Live Preview) — 挪到 Settings；
                Live Preview 后续挪到 SessionWorkspaceBar 顶栏 */}

            {/* 弹性空白 */}
            <div className="flex-1" />

            {/* 累计费用 — Context pill 左边 */}
            {sessionCost > 0 && (
              <span className="text-xs mr-1 tabular-nums">
                <CostDisplay cost={sessionCost} isStreaming={statusStreaming} />
              </span>
            )}

            {/* B+ 移除: InteractionModeIndicator — 已收进 InputAddMenu 二级菜单 */}

            {/* 上下文使用 pill — 模型选择器左边，Codex 风格 */}
            <ContextUsagePill />

            {/* 模型选择器 */}
            <div className="text-xs">
              <ModelSwitcher currentModel={modelConfig.model} />
            </div>

            {/* 语音输入按钮 */}
            {!disabled && (
              <VoiceInputButton
                onTranscript={handleVoiceTranscript}
                disabled={disabled}
              />
            )}
            {/* 发送/停止/补充指令按钮 */}
            <SendButton
              disabled={disabled && !isProcessing}
              isProcessing={isProcessing}
              isInterrupting={isInterrupting}
              hasContent={hasContent}
              type="submit"
              onStop={onStop}
            />
          </div>
        </div>
      </form>
    </div>
  );
});

ChatInput.displayName = 'ChatInput';

export default ChatInput;
