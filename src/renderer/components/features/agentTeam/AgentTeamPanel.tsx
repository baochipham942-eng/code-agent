// ============================================================================
// AgentTeamPanel - Agent Teams P2P 通信面板
// ============================================================================
// 功能：
// 1. 左侧：agent 列表（名称、角色、状态指示灯）
// 2. 中间：选中 agent 的消息流（含 agent 间对话 + 用户消息）
// 3. 底部：用户可输入消息直接发给选中 agent
// ============================================================================

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  X,
  Users,
  Send,
  MessageSquare,
  Circle,
  ChevronRight,
  ChevronDown,
  Clock,
  ArrowRightLeft,
  ShieldCheck,
  ShieldX,
  ListTodo,
} from 'lucide-react';
import { useSwarmStore } from '../../../stores/swarmStore';
import type { SwarmAgentState } from '@shared/types/swarm';

// ============================================================================
// Types
// ============================================================================

interface TeammateMessageDisplay {
  id: string;
  from: string;
  to: string;
  content: string;
  timestamp: number;
  type: 'coordination' | 'handoff' | 'query' | 'response' | 'broadcast' | 'user';
}

interface AgentTeamPanelProps {
  onClose?: () => void;
}

// ============================================================================
// Sub-components
// ============================================================================

const StatusDot: React.FC<{ status: SwarmAgentState['status'] }> = ({ status }) => {
  const colors: Record<string, string> = {
    running: 'text-amber-400 animate-pulse',
    completed: 'text-emerald-400',
    failed: 'text-red-400',
    pending: 'text-zinc-500',
    ready: 'text-blue-400',
    cancelled: 'text-zinc-600',
  };

  return <Circle className={`w-2.5 h-2.5 fill-current ${colors[status] || 'text-zinc-500'}`} />;
};

const AgentListItem: React.FC<{
  agent: SwarmAgentState;
  selected: boolean;
  onClick: () => void;
  unreadCount?: number;
}> = ({ agent, selected, onClick, unreadCount }) => (
  <button
    onClick={onClick}
    className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg transition-all ${
      selected
        ? 'bg-zinc-700/60 border border-zinc-600/40'
        : 'hover:bg-zinc-800/40 border border-transparent'
    }`}
  >
    <StatusDot status={agent.status} />
    <div className="flex-1 text-left min-w-0">
      <div className="text-sm text-zinc-200 truncate">{agent.name}</div>
      <div className="text-xs text-zinc-500 truncate">{agent.role}</div>
    </div>
    {unreadCount && unreadCount > 0 && (
      <span className="px-1.5 py-0.5 text-xs font-medium text-white bg-cyan-500 rounded-full">
        {unreadCount}
      </span>
    )}
    <ChevronRight className="w-3.5 h-3.5 text-zinc-600" />
  </button>
);

const MessageItem: React.FC<{ message: TeammateMessageDisplay; currentAgentId?: string }> = ({
  message,
  currentAgentId,
}) => {
  const isSent = message.from === currentAgentId || message.from === 'user';
  const isUser = message.from === 'user' || message.type === 'user';

  const typeIcons: Record<string, React.ReactNode> = {
    coordination: <ArrowRightLeft className="w-3 h-3 text-blue-400" />,
    handoff: <ArrowRightLeft className="w-3 h-3 text-amber-400" />,
    query: <MessageSquare className="w-3 h-3 text-violet-400" />,
    response: <MessageSquare className="w-3 h-3 text-emerald-400" />,
    broadcast: <Users className="w-3 h-3 text-cyan-400" />,
    user: <Users className="w-3 h-3 text-white" />,
  };

  // Plan review rendering
  const isPlanReview = message.content.startsWith('[Plan Review]');
  const isPlanApproved = message.content.startsWith('[Plan Approved]');
  const isPlanRejected = message.content.startsWith('[Plan Rejected]');

  return (
    <div className={`flex ${isSent ? 'justify-end' : 'justify-start'} mb-2`}>
      <div
        className={`max-w-[85%] px-3 py-2 rounded-lg text-xs ${
          isUser
            ? 'bg-cyan-500/20 border border-cyan-500/30 text-cyan-100'
            : isPlanApproved
            ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-200'
            : isPlanRejected
            ? 'bg-red-500/10 border border-red-500/20 text-red-200'
            : isPlanReview
            ? 'bg-amber-500/10 border border-amber-500/20 text-amber-200'
            : isSent
            ? 'bg-zinc-700/40 border border-zinc-600/30 text-zinc-200'
            : 'bg-zinc-800/40 border border-zinc-700/30 text-zinc-300'
        }`}
      >
        {/* Header */}
        <div className="flex items-center gap-1.5 mb-1">
          {typeIcons[message.type] || typeIcons.coordination}
          <span className="font-medium text-zinc-400">
            {message.from === 'user' ? 'You' : message.from}
          </span>
          {isPlanReview && <ShieldCheck className="w-3 h-3 text-amber-400" />}
          {isPlanApproved && <ShieldCheck className="w-3 h-3 text-emerald-400" />}
          {isPlanRejected && <ShieldX className="w-3 h-3 text-red-400" />}
          <span className="text-zinc-600 ml-auto">
            {new Date(message.timestamp).toLocaleTimeString()}
          </span>
        </div>
        {/* Content */}
        <p className="whitespace-pre-wrap leading-relaxed">{message.content}</p>
      </div>
    </div>
  );
};

// 任务分配概览
const TaskAssignments: React.FC<{ agents: SwarmAgentState[] }> = ({ agents }) => {
  const [expanded, setExpanded] = useState(false);
  const activeAgents = agents.filter(a => a.status === 'running' || a.status === 'completed' || a.status === 'failed');

  if (activeAgents.length === 0) return null;

  return (
    <div className="border-b border-zinc-800/50">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-zinc-400 hover:text-zinc-300 transition-colors"
      >
        <ListTodo className="w-3.5 h-3.5" />
        <span className="font-medium">任务分配</span>
        <span className="text-zinc-600 ml-auto">{activeAgents.length}</span>
        {expanded ? (
          <ChevronDown className="w-3 h-3 text-zinc-600" />
        ) : (
          <ChevronRight className="w-3 h-3 text-zinc-600" />
        )}
      </button>
      {expanded && (
        <div className="px-3 pb-2 space-y-1">
          {activeAgents.map(agent => (
            <div
              key={agent.id}
              className="flex items-center gap-2 px-2 py-1.5 rounded bg-zinc-800/30 border border-zinc-700/20"
            >
              <StatusDot status={agent.status} />
              <span className="text-xs text-zinc-300 truncate flex-1">{agent.name}</span>
              {agent.lastReport && (
                <span className="text-xs text-zinc-500 truncate max-w-[120px]">{agent.lastReport}</span>
              )}
              {agent.toolCalls != null && agent.toolCalls > 0 && (
                <span className="text-xs text-zinc-600">{agent.toolCalls} tools</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Main Component
// ============================================================================

export const AgentTeamPanel: React.FC<AgentTeamPanelProps> = ({ onClose }) => {
  const { agents, isRunning } = useSwarmStore();
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState('');
  const [messages, setMessages] = useState<TeammateMessageDisplay[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 滚动到底部
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // 监听 swarm 事件中的消息
  useEffect(() => {
    if (!window.electronAPI) return;
    const unsubscribe = window.electronAPI.on('swarm:event', (event) => {
      // 转发到 swarmStore 处理基础状态
      useSwarmStore.getState().handleEvent(event);

      // 处理 Agent Teams 消息事件
      if (event.type === 'swarm:agent:message' || event.type === 'swarm:user:message') {
        const msgData = event.data?.message;
        if (msgData) {
          setMessages(prev => [...prev, {
            id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            from: msgData.from,
            to: msgData.to,
            content: msgData.content,
            timestamp: Date.now(),
            type: (msgData.messageType || 'coordination') as TeammateMessageDisplay['type'],
          }]);
        }
      }
    });
    return () => unsubscribe();
  }, []);

  // 发送消息给选中的 agent
  const handleSend = useCallback(async () => {
    if (!inputValue.trim() || !selectedAgentId) return;

    const message: TeammateMessageDisplay = {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      from: 'user',
      to: selectedAgentId,
      content: inputValue.trim(),
      timestamp: Date.now(),
      type: 'user',
    };

    setMessages(prev => [...prev, message]);
    setInputValue('');

    // 通过 IPC 发送给主进程
    try {
      await window.electronAPI?.invoke('swarm:send-user-message', {
        agentId: selectedAgentId,
        message: inputValue.trim(),
      });
    } catch (error) {
      console.error('Failed to send message:', error);
    }
  }, [inputValue, selectedAgentId]);

  const selectedAgent = agents.find(a => a.id === selectedAgentId);
  const filteredMessages = selectedAgentId
    ? messages.filter(
        m => m.from === selectedAgentId || m.to === selectedAgentId || m.to === 'all'
      )
    : messages;

  // 空状态
  if (agents.length === 0 && !isRunning) {
    return (
      <div className="w-80 flex flex-col border-l border-zinc-800 bg-zinc-900/50">
        <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-zinc-200">Agent Teams</h3>
            <p className="text-xs text-zinc-500 mt-0.5">Agent 间通信</p>
          </div>
          {onClose && (
            <button
              onClick={onClose}
              className="p-1 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50 rounded transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center text-zinc-500">
            <Users className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p className="text-sm">暂无活跃的 Agent 团队</p>
            <p className="text-xs mt-1">当多 Agent 协作任务启动时显示</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="w-80 flex flex-col border-l border-zinc-800 bg-zinc-900/50">
      {/* Header */}
      <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-zinc-200 flex items-center gap-2">
            Agent Teams
            {isRunning && (
              <span className="flex items-center gap-1 text-xs text-cyan-400">
                <Clock className="w-3 h-3 animate-pulse" />
                运行中
              </span>
            )}
          </h3>
          <p className="text-xs text-zinc-500 mt-0.5">
            {agents.length} 个 Agent · {messages.length} 条消息
          </p>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="p-1 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/50 rounded transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Agent List */}
      <div className="px-2 py-2 border-b border-zinc-800/50 max-h-40 overflow-y-auto">
        {agents.map(agent => (
          <AgentListItem
            key={agent.id}
            agent={agent}
            selected={selectedAgentId === agent.id}
            onClick={() => setSelectedAgentId(agent.id)}
          />
        ))}
      </div>

      {/* Task Assignments */}
      <TaskAssignments agents={agents} />

      {/* Message Flow */}
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {filteredMessages.length === 0 ? (
          <div className="flex items-center justify-center h-full text-zinc-600 text-xs">
            {selectedAgent
              ? `暂无与 ${selectedAgent.name} 的消息`
              : '选择一个 Agent 查看消息'}
          </div>
        ) : (
          <>
            {filteredMessages.map(msg => (
              <MessageItem key={msg.id} message={msg} currentAgentId={selectedAgentId || undefined} />
            ))}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* Input Area */}
      {selectedAgentId && (
        <div className="px-3 py-2.5 border-t border-zinc-800">
          <div className="flex items-center gap-2">
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={e => setInputValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder={`发消息给 ${selectedAgent?.name || 'Agent'}...`}
              className="flex-1 bg-zinc-800/50 border border-zinc-700/30 rounded-lg px-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-cyan-500/40"
            />
            <button
              onClick={handleSend}
              disabled={!inputValue.trim()}
              className="p-1.5 rounded-lg bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <Send className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default AgentTeamPanel;
