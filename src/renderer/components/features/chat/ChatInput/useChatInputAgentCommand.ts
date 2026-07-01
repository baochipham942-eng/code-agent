import { useCallback, useEffect, useMemo, useState } from 'react';
import type React from 'react';
import type { InputAreaRef } from './InputArea';
import {
  applyAgentMentionSuggestion,
  getLeadingAgentMentionAutocomplete,
} from './agentMentionRouting';
import { NEO_TAG_MENTION_AGENT } from './neoMentionRouting';
import {
  applyAgentCommandOption,
  getAgentCommandOptions,
  getAgentSlashCommandQuery,
} from './agentCommand';

export interface UseChatInputAgentCommandParams {
  /** 当前输入框文本（组件持有，单向喂入）。 */
  value: string;
  /** Swarm agent 列表（@ mention 自动补全数据源）。 */
  swarmAgents: Parameters<typeof getLeadingAgentMentionAutocomplete>[1];
  /** Agent 注册表条目（/agent 命令自动补全数据源）。 */
  agentEntries: Parameters<typeof getAgentCommandOptions>[0];
  /** 输入框 imperative ref（聚焦用）。 */
  inputAreaRef: React.RefObject<InputAreaRef | null>;
  /** 下一帧聚焦输入框（全组件共用，组件持有）。 */
  focusComposer: () => void;
  setValue: React.Dispatch<React.SetStateAction<string>>;
  setShowSlashPopover: React.Dispatch<React.SetStateAction<boolean>>;
  setSlashFilter: React.Dispatch<React.SetStateAction<string>>;
}

/**
 * ChatInput 的 agent 自动补全单元：@ mention 与 /agent 命令的
 * state（选中索引 / 已 dismiss 值）、派生数据、键盘导航与选择 handler。
 * 纯结构性抽取自 index.tsx，零行为改动。
 */
export function useChatInputAgentCommand(params: UseChatInputAgentCommandParams) {
  const {
    value,
    swarmAgents,
    agentEntries,
    inputAreaRef,
    focusComposer,
    setValue,
    setShowSlashPopover,
    setSlashFilter,
  } = params;

  const [selectedAgentMentionIndex, setSelectedAgentMentionIndex] = useState(0);
  const [selectedAgentCommandIndex, setSelectedAgentCommandIndex] = useState(0);
  const [dismissedAgentAutocompleteValue, setDismissedAgentAutocompleteValue] = useState<string | null>(null);

  const agentMentionAutocomplete = useMemo(
    () => getLeadingAgentMentionAutocomplete(value, swarmAgents),
    [swarmAgents, value],
  );
  const isAgentMentionAutocompleteOpen = Boolean(
    agentMentionAutocomplete
    && agentMentionAutocomplete.matches.length > 0
    && dismissedAgentAutocompleteValue !== value,
  );
  const agentSlashCommandQuery = useMemo(() => getAgentSlashCommandQuery(value), [value]);
  const agentCommandOptions = useMemo(
    () => agentSlashCommandQuery === null ? [] : getAgentCommandOptions(agentEntries, agentSlashCommandQuery),
    [agentEntries, agentSlashCommandQuery],
  );
  const isAgentCommandAutocompleteOpen = agentSlashCommandQuery !== null && agentCommandOptions.length > 0;

  useEffect(() => {
    setSelectedAgentMentionIndex(0);
    if (dismissedAgentAutocompleteValue && dismissedAgentAutocompleteValue !== value) {
      setDismissedAgentAutocompleteValue(null);
    }
  }, [agentMentionAutocomplete?.query, agentMentionAutocomplete?.matches.length, dismissedAgentAutocompleteValue, value]);

  useEffect(() => {
    setSelectedAgentCommandIndex(0);
  }, [agentSlashCommandQuery, agentCommandOptions.length]);

  const handleAgentMentionSelect = useCallback((agentId: string) => {
    const agent = agentId === NEO_TAG_MENTION_AGENT.id
      ? NEO_TAG_MENTION_AGENT
      : swarmAgents.find((item) => item.id === agentId);
    if (!agent) return;
    setValue((prev) => applyAgentMentionSuggestion(prev, agent));
    setDismissedAgentAutocompleteValue(null);
    inputAreaRef.current?.focus();
  }, [inputAreaRef, setValue, swarmAgents]);

  const openAgentCommand = useCallback(() => {
    setValue('/agent ');
    setShowSlashPopover(false);
    setSlashFilter('');
    setDismissedAgentAutocompleteValue(null);
    focusComposer();
  }, [focusComposer, setSlashFilter, setShowSlashPopover, setValue]);

  const handleAgentCommandOptionSelect = useCallback((index: number) => {
    const option = agentCommandOptions[index];
    if (!option) return;
    setValue(applyAgentCommandOption(option));
    setSelectedAgentCommandIndex(index);
    requestAnimationFrame(() => inputAreaRef.current?.focus());
  }, [agentCommandOptions, inputAreaRef, setValue]);

  const handleAutocompleteKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isAgentCommandAutocompleteOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedAgentCommandIndex((prev) => (prev + 1) % agentCommandOptions.length);
        return true;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedAgentCommandIndex((prev) => (
          prev === 0 ? agentCommandOptions.length - 1 : prev - 1
        ));
        return true;
      }

      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        handleAgentCommandOptionSelect(selectedAgentCommandIndex);
        return true;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        setValue('');
        return true;
      }
    }

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
    agentCommandOptions.length,
    handleAgentCommandOptionSelect,
    handleAgentMentionSelect,
    isAgentCommandAutocompleteOpen,
    isAgentMentionAutocompleteOpen,
    selectedAgentCommandIndex,
    selectedAgentMentionIndex,
    setValue,
    value,
  ]);

  return {
    selectedAgentMentionIndex,
    selectedAgentCommandIndex,
    agentMentionAutocomplete,
    agentCommandOptions,
    isAgentMentionAutocompleteOpen,
    isAgentCommandAutocompleteOpen,
    openAgentCommand,
    handleAgentMentionSelect,
    handleAgentCommandOptionSelect,
    handleAutocompleteKeyDown,
  };
}
