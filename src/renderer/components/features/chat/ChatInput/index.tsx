// ============================================================================
// ChatInput - 消息输入组件主入口
// 支持多模态输入：文本、图片、代码、PDF、文件夹
// 深度研究通过语义自动检测触发，无需手动切换
// ============================================================================

import React, { useState, useRef, useCallback, useEffect, useImperativeHandle, forwardRef, useMemo } from 'react';
import { Image, FileText, Pause, Play, SlashSquare } from 'lucide-react';
import type { MessageAttachment } from '../../../../../shared/contract';
import type { ConversationEnvelope } from '@shared/contract/conversationEnvelope';
import { UI } from '@shared/constants';

import { InputArea, InputAreaRef } from './InputArea';
import { AttachmentBar } from './AttachmentBar';
import { SendButton } from './SendButton';
import { SuggestionBar } from './SuggestionBar';
import { VoiceInputButton } from './VoiceInputButton';
import { AbilityMenu } from './AbilityMenu';
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
import { InteractionModeIndicator } from '../../../StatusBar/InteractionModeIndicator';
import { EffortLevelIndicator } from '../../../StatusBar/EffortLevelIndicator';
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
import { buildBrowserSessionIntentSnapshot } from '../../../../utils/browserExecutionIntent';

// ============================================================================
// 类型定义
// ============================================================================

export interface ChatInputProps {
  onSend: (envelope: ConversationEnvelope) => void;
  disabled?: boolean;
  /** 是否正在处理（用于显示停止按钮） */
  isProcessing?: boolean;
  /** 是否正在中断（Claude Code 风格：中断当前任务切换到新指令） */
  isInterrupting?: boolean;
  /** 停止处理回调 */
  onStop?: () => void;
  /** 是否已暂停 */
  isPaused?: boolean;
  /** 暂停回调 */
  onPause?: () => void;
  /** 恢复回调 */
  onResume?: () => void;
  /** 是否有 Plan */
  hasPlan?: boolean;
  /** 点击 Plan 入口 */
  onPlanClick?: () => void;
}

// Imperative handle exposed to parent (e.g. ChatView drop zone)
export interface ChatInputHandle {
  addAttachments: (items: MessageAttachment[]) => void;
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
  isPaused,
  onPause,
  onResume,
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

  const buildEnvelope = useCallback((rawContent: string, nextAttachments?: MessageAttachment[]): ConversationEnvelope => {
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

    return {
      content,
      attachments: nextAttachments && nextAttachments.length > 0 ? nextAttachments : undefined,
      context,
    };
  }, [browserSession, buildContext, swarmAgents]);

  // Expose addAttachments to parent via ref (for global drop zone)
  useImperativeHandle(ref, () => ({
    addAttachments: (items: MessageAttachment[]) => {
      if (items.length > 0) {
        setAttachments((prev) => [...prev, ...items].slice(0, UI.MAX_ATTACHMENTS_DROP));
      }
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
        onSend(buildEnvelope(text));
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
        onSend(buildEnvelope(`Execute this shell command and show the output: \`${cmd.trim()}\``));
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

  // 处理提交
  // Claude Code 风格：即使正在处理也允许提交（触发中断）
  // P3-18: ! prefix executes shell command directly
  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const trimmedValue = value.trim();
    const nextEnvelope = buildEnvelope(trimmedValue, attachments);
    // 允许在 isProcessing 时提交以触发中断功能
    const canSubmit = ((nextEnvelope.content.trim().length > 0) || attachments.length > 0) && (!disabled || isProcessing) && !isUploading;
    if (canSubmit) {
      // 添加到输入历史
      if (trimmedValue) {
        addToInputHistory(trimmedValue);
      }
      // P3-18: Shell shortcut - ! prefix sends command to agent as bash request
      if (nextEnvelope.content.startsWith('!')) {
        const shellCmd = nextEnvelope.content.slice(1).trim();
        if (shellCmd) {
          // Send as a bash execution request to the agent
          onSend({
            content: `Execute this shell command and show the output: \`${shellCmd}\``,
            context: nextEnvelope.context,
          });
        }
      } else {
        onSend(nextEnvelope);
      }
      setValue('');
      setAttachments([]);
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
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
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
      const items = e.dataTransfer.items;
      const newAttachments: MessageAttachment[] = [];

      if (items) {
        const entries: FileSystemEntry[] = [];
        for (let i = 0; i < items.length; i++) {
          const entry = items[i].webkitGetAsEntry?.();
          if (entry) entries.push(entry);
        }

        for (const entry of entries) {
          if (entry.isFile) {
            const fileEntry = entry as FileSystemFileEntry;
            const file = await new Promise<File>((resolve, reject) => {
              fileEntry.file(resolve, reject);
            });
            const attachment = await processFile(file);
            if (attachment) newAttachments.push(attachment);
          } else if (entry.isDirectory) {
            const dirEntry = entry as FileSystemDirectoryEntry;
            const folderAttachment = await processFolderEntry(dirEntry, entry.name);
            if (folderAttachment) newAttachments.push(folderAttachment);
          }
        }
      } else {
        const files = Array.from(e.dataTransfer.files);
        for (const file of files) {
          const attachment = await processFile(file);
          if (attachment) newAttachments.push(attachment);
        }
      }

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

        {/* 输入区域 - 玻璃质感样式 */}
        <div className="relative bg-white/[0.03] backdrop-blur-sm rounded-2xl border border-white/[0.08] focus-within:border-white/[0.15] focus-within:bg-white/[0.05] transition-all duration-200 shadow-lg shadow-black/20">
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
            placeholder={inputPlaceholder}
            onHistoryPrev={getPreviousInput}
            onHistoryNext={getNextInput}
            onHistoryReset={resetInputHistoryIndex}
            onAutocompleteKeyDown={handleAutocompleteKeyDown}
          />
          {/* 底部工具栏 */}
          <div className="flex items-center gap-1 px-3 pb-3">
            {/* / 命令按钮 */}
            <button
              type="button"
              onClick={() => { setShowSlashPopover(true); setSlashFilter(''); }}
              className="flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700/50 transition-colors"
              aria-label="命令"
              title="输入 / 命令"
            >
              <SlashSquare className="w-4 h-4" />
            </button>

            {/* 附件按钮 */}
            <label
              className="flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700/50 transition-colors cursor-pointer"
              aria-label="添加图片或文件"
              title="添加图片或文件"
            >
              <Image className="w-4 h-4" />
              <input
                type="file"
                multiple
                onChange={(e) => { if (e.target.files) handleFileSelect(e.target.files); e.target.value = ''; }}
                className="hidden"
              />
            </label>

            {/* 权限模式 chip — Default / Full Access */}
            <PermissionToggle disabled={disabled && !isProcessing} />

            {/* 能力 popover — Routing + Browser */}
            <AbilityMenu disabled={disabled && !isProcessing} browserSession={browserSession} />

            {/* 弹性空白 */}
            <div className="flex-1" />

            {/* 累计费用 — Context pill 左边 */}
            {sessionCost > 0 && (
              <span className="text-xs mr-1 tabular-nums">
                <CostDisplay cost={sessionCost} isStreaming={statusStreaming} />
              </span>
            )}

            {/* 交互模式 + 推理 effort 切换器（Codex 风格一等公民） */}
            <div className="text-xs">
              <InteractionModeIndicator />
            </div>
            <div className="text-xs">
              <EffortLevelIndicator />
            </div>

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
            {/* 暂停/恢复按钮 — 仅在处理中时显示 */}
            {isProcessing && !isInterrupting && (
              <button
                type="button"
                onClick={isPaused ? onResume : onPause}
                className={`flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center transition-all duration-200 ${
                  isPaused
                    ? 'text-green-400 bg-green-500/20 hover:bg-green-500/30'
                    : 'text-amber-400 bg-amber-500/20 hover:bg-amber-500/30'
                }`}
                aria-label={isPaused ? '恢复' : '暂停'}
                title={isPaused ? '恢复执行' : '暂停（完成当前步骤后停止）'}
              >
                {isPaused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
              </button>
            )}
            {/* 发送/停止/中断按钮 */}
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
