import { useCallback } from 'react';
import type React from 'react';
import type { MessageAttachment } from '@shared/contract';
import type { SpeechTranscribeResult } from '@shared/contract';
import type { ConversationVoiceInputMetadata } from '@shared/contract/conversationEnvelope';
import { UI } from '@shared/constants';
import { toast } from '../../../../hooks/useToast';
import { useSessionStore } from '../../../../stores/sessionStore';
import type { InputAreaRef } from './InputArea';

type VoiceInputContextValue = {
  anchor: string;
  metadata: ConversationVoiceInputMetadata;
} | null;

export interface UseChatInputComposerActionsParams {
  currentSessionId: string | null;
  currentSessionMemoryMode: string;
  processFile: (file: File) => Promise<MessageAttachment | null>;
  inputAreaRef: React.RefObject<InputAreaRef | null>;
  setIsUploading: React.Dispatch<React.SetStateAction<boolean>>;
  setAttachments: React.Dispatch<React.SetStateAction<MessageAttachment[]>>;
  setValue: React.Dispatch<React.SetStateAction<string>>;
  setVoiceInputContext: React.Dispatch<React.SetStateAction<VoiceInputContextValue>>;
}

/**
 * ChatInput 的附件 / 语音 / 记忆开关动作单元：
 * 文件选择、图片粘贴、附件移除、语音转写回填、本会话记忆开关。
 * 纯结构性抽取自 index.tsx，零行为改动。
 */
export function useChatInputComposerActions(params: UseChatInputComposerActionsParams) {
  const {
    currentSessionId,
    currentSessionMemoryMode,
    processFile,
    inputAreaRef,
    setIsUploading,
    setAttachments,
    setValue,
    setVoiceInputContext,
  } = params;

  const updateSessionMemoryMode = useSessionStore((state) => state.updateSessionMemoryMode);

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
  }, [processFile, setAttachments, setIsUploading]);

  // 移除附件
  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  // 语音输入回调 - 追加到现有文本
  const handleVoiceTranscript = useCallback((text: string, result?: SpeechTranscribeResult) => {
    const transcript = text.trim();
    if (transcript) {
      const rawTranscript = result?.rawText?.trim();
      setValue(prev => {
        const current = prev.trimEnd();
        if (!current) return transcript;
        return `${current}\n\n${transcript}`;
      });
      setVoiceInputContext({
        anchor: transcript.slice(0, 64),
        metadata: {
          inputSource: 'voice',
          asrEngine: result?.engine,
          language: result?.language,
          model: result?.model,
          durationMs: result?.durationMs,
          audioDurationSeconds: result?.audioDurationSeconds,
          transcriptionMode: result?.engine === 'groq' ? 'cloud' : result?.engine === 'local-whisper' ? 'local' : undefined,
          transcriptChars: transcript.length,
          rawTranscriptChars: rawTranscript?.length,
          postProcessed: Boolean(rawTranscript && rawTranscript !== transcript),
          chunkCount: result?.chunkCount,
        },
      });
      // 聚焦输入框
      inputAreaRef.current?.focus();
    }
  }, [inputAreaRef, setValue, setVoiceInputContext]);

  const handleMemoryModeToggle = useCallback(async () => {
    if (!currentSessionId) return;
    const nextMode = currentSessionMemoryMode === 'off' ? 'auto' : 'off';
    try {
      await updateSessionMemoryMode(currentSessionId, nextMode);
      toast.success(nextMode === 'off' ? '本会话记忆已关闭' : '本会话记忆已开启');
    } catch (error) {
      toast.error(`更新记忆设置失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  }, [currentSessionId, currentSessionMemoryMode, updateSessionMemoryMode]);

  return {
    handleFileSelect,
    handleImagePaste,
    removeAttachment,
    handleVoiceTranscript,
    handleMemoryModeToggle,
  };
}
