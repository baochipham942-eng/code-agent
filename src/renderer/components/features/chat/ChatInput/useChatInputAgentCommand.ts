import { useCallback, useEffect, useMemo, useState } from 'react';
import type React from 'react';
import type { InputAreaRef } from './InputArea';
import {
  applyAgentMentionSuggestion,
  getLeadingAgentMentionAutocomplete,
} from './agentMentionRouting';
import {
  buildNeoTopicMentionCandidates,
  NEO_TAG_MENTION_AGENT,
  NEO_TOPIC_MENTION_PREFIX,
} from './neoMentionRouting';
import { useI18n } from '../../../../hooks/useI18n';
import {
  applyAgentCommandOption,
  getAgentCommandOptions,
  getAgentSlashCommandQuery,
} from './agentCommand';
import { useNeoWorkCardStore } from '../../../../stores/neoWorkCardStore';

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
  const { t } = useI18n();
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

  // @neo 下拉的「续接既有 topic」候选（ADR-035 D1）：数据源 = store 全局目录，
  // 下拉首次可见时懒加载一次（listAll，与「Neo 协同」目录同源）。
  const detailsById = useNeoWorkCardStore((state) => state.detailsById);
  const loadAllTopics = useNeoWorkCardStore((state) => state.loadAll);
  const [topicsLoaded, setTopicsLoaded] = useState(false);
  const neoTopicCandidates = useMemo(
    () => buildNeoTopicMentionCandidates(Object.values(detailsById).map((detail) => ({
      workCardId: detail.workCard.id,
      title: detail.workCard.title,
      status: detail.workCard.status,
      updatedAt: detail.workCard.updatedAt,
    })), t),
    [detailsById, t],
  );

  const agentMentionAutocomplete = useMemo(
    () => getLeadingAgentMentionAutocomplete(value, swarmAgents, neoTopicCandidates, t),
    [neoTopicCandidates, swarmAgents, value, t],
  );

  useEffect(() => {
    if (agentMentionAutocomplete && !topicsLoaded) {
      setTopicsLoaded(true);
      void loadAllTopics().catch(() => {});
    }
  }, [agentMentionAutocomplete, loadAllTopics, topicsLoaded]);
  const isAgentMentionAutocompleteOpen = Boolean(
    agentMentionAutocomplete
    && agentMentionAutocomplete.matches.length > 0
    && dismissedAgentAutocompleteValue !== value,
  );
  const agentSlashCommandQuery = useMemo(() => getAgentSlashCommandQuery(value), [value]);
  const agentCommandOptions = useMemo(
    () => agentSlashCommandQuery === null
      ? []
      : getAgentCommandOptions(agentEntries, agentSlashCommandQuery, {
        defaultDescription: t.agentCommand.defaultDescription,
      }),
    [agentEntries, agentSlashCommandQuery, t],
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
    // 续接既有 topic（ADR-035）：挂 composer chip（可移除），正文照常插 `@neo `——不做文本编码。
    if (agentId.startsWith(NEO_TOPIC_MENTION_PREFIX)) {
      const workCardId = agentId.slice(NEO_TOPIC_MENTION_PREFIX.length);
      const detail = useNeoWorkCardStore.getState().detailsById[workCardId];
      if (detail) {
        useNeoWorkCardStore.getState().setContinuationTarget({
          workCardId,
          title: detail.workCard.title,
        });
      }
      setValue((prev) => applyAgentMentionSuggestion(prev, NEO_TAG_MENTION_AGENT));
      setDismissedAgentAutocompleteValue(null);
      inputAreaRef.current?.focus();
      return;
    }
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
