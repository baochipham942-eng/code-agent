// ============================================================================
// AgentsSettings - Agent 路由管理 Tab
// ============================================================================

import React, { useState, useEffect, useCallback } from 'react';
import {
  Bot,
  Plus,
  Trash2,
  Edit2,
  Check,
  X,
  AlertCircle,
  Loader2,
  ChevronDown,
  ChevronUp,
  Star,
  ToggleLeft,
  ToggleRight,
} from 'lucide-react';
import { Button, Input } from '../../../primitives';
import { IPC_CHANNELS } from '@shared/ipc';
import type { AgentRoutingConfig, AgentBinding } from '@shared/types/agentRouting';
import { createLogger } from '../../../../utils/logger';

const logger = createLogger('AgentsSettings');

// IPC helper
const invokeAgentIPC = async <T = unknown>(channel: string, ...args: unknown[]): Promise<T | undefined> => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await (window.electronAPI?.invoke as any)(channel, ...args) as T;
  } catch (err) {
    logger.error(`IPC invoke failed for ${channel}`, err);
    return undefined;
  }
};

// ============================================================================
// Sub Components
// ============================================================================

interface BindingTagProps {
  binding: AgentBinding;
}

const BindingTag: React.FC<BindingTagProps> = ({ binding }) => {
  const getLabel = () => {
    switch (binding.type) {
      case 'always':
        return '始终';
      case 'directory':
        return `目录: ${binding.match.directory}`;
      case 'file_pattern':
        return `文件: ${binding.match.filePattern}`;
      case 'keyword':
        return `关键词: ${binding.match.keywords?.join(', ')}`;
      case 'intent':
        return `意图: ${binding.match.intent}`;
      default:
        return binding.type;
    }
  };

  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-zinc-700/50 text-zinc-400">
      {getLabel()}
      {binding.priority !== undefined && binding.priority !== 0 && (
        <span className="ml-1 text-zinc-500">({binding.priority})</span>
      )}
    </span>
  );
};

interface AgentCardProps {
  agent: AgentRoutingConfig;
  isDefault: boolean;
  onEdit: (agent: AgentRoutingConfig) => void;
  onDelete: (id: string) => void;
  onToggleEnabled: (id: string, enabled: boolean) => void;
  onSetDefault: (id: string) => void;
}

const AgentCard: React.FC<AgentCardProps> = ({
  agent,
  isDefault,
  onEdit,
  onDelete,
  onToggleEnabled,
  onSetDefault,
}) => {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={`bg-zinc-800/50 rounded-lg border ${
      isDefault ? 'border-amber-500/50' : 'border-zinc-700'
    } overflow-hidden`}>
      {/* Header */}
      <div className="p-4">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <Bot className={`w-5 h-5 shrink-0 ${
              agent.enabled !== false ? 'text-emerald-400' : 'text-zinc-500'
            }`} />
            <div>
              <div className="flex items-center gap-2">
                <h4 className="text-sm font-medium text-zinc-100">{agent.name}</h4>
                {isDefault && (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-amber-500/20 text-amber-400">
                    <Star className="w-3 h-3" />
                    默认
                  </span>
                )}
              </div>
              <p className="text-xs text-zinc-400 mt-0.5">{agent.description}</p>
            </div>
          </div>
          <button
            onClick={() => onToggleEnabled(agent.id, agent.enabled === false)}
            className="text-zinc-400 hover:text-zinc-200"
          >
            {agent.enabled !== false ? (
              <ToggleRight className="w-5 h-5 text-emerald-400" />
            ) : (
              <ToggleLeft className="w-5 h-5" />
            )}
          </button>
        </div>

        {/* Bindings */}
        {agent.bindings && agent.bindings.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {agent.bindings.slice(0, expanded ? undefined : 3).map((binding, i) => (
              <BindingTag key={i} binding={binding} />
            ))}
            {!expanded && agent.bindings.length > 3 && (
              <button
                onClick={() => setExpanded(true)}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-zinc-700/50 text-zinc-400 hover:bg-zinc-700"
              >
                +{agent.bindings.length - 3} 更多
                <ChevronDown className="w-3 h-3" />
              </button>
            )}
            {expanded && agent.bindings.length > 3 && (
              <button
                onClick={() => setExpanded(false)}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-zinc-700/50 text-zinc-400 hover:bg-zinc-700"
              >
                收起
                <ChevronUp className="w-3 h-3" />
              </button>
            )}
          </div>
        )}

        {/* Tags */}
        {agent.tags && agent.tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {agent.tags.map((tag) => (
              <span key={tag} className="px-1.5 py-0.5 rounded text-xs bg-blue-500/20 text-blue-400">
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="px-4 py-3 bg-zinc-800/30 border-t border-zinc-700/50 flex justify-between">
        <div>
          {!isDefault && agent.id !== 'default' && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onSetDefault(agent.id)}
              leftIcon={<Star className="w-3 h-3" />}
            >
              设为默认
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onEdit(agent)}
            leftIcon={<Edit2 className="w-3 h-3" />}
          >
            编辑
          </Button>
          {agent.id !== 'default' && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onDelete(agent.id)}
              leftIcon={<Trash2 className="w-3 h-3" />}
              className="text-red-400 hover:text-red-300 hover:bg-red-500/10"
            >
              删除
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// Edit Modal
// ============================================================================

interface AgentEditModalProps {
  agent: AgentRoutingConfig | null;
  isNew: boolean;
  onSave: (agent: AgentRoutingConfig) => void;
  onCancel: () => void;
}

const AgentEditModal: React.FC<AgentEditModalProps> = ({
  agent,
  isNew,
  onSave,
  onCancel,
}) => {
  const [formData, setFormData] = useState<Partial<AgentRoutingConfig>>({
    id: '',
    name: '',
    description: '',
    systemPrompt: '',
    tools: [],
    bindings: [],
    tags: [],
    enabled: true,
  });
  const [bindingsText, setBindingsText] = useState('');
  const [toolsText, setToolsText] = useState('');
  const [tagsText, setTagsText] = useState('');

  useEffect(() => {
    if (agent) {
      setFormData(agent);
      setBindingsText(agent.bindings ? JSON.stringify(agent.bindings, null, 2) : '[]');
      setToolsText(agent.tools?.join(', ') || '');
      setTagsText(agent.tags?.join(', ') || '');
    }
  }, [agent]);

  const handleSave = () => {
    try {
      const bindings = bindingsText.trim() ? JSON.parse(bindingsText) : [];
      const tools = toolsText.trim() ? toolsText.split(',').map(t => t.trim()).filter(Boolean) : undefined;
      const tags = tagsText.trim() ? tagsText.split(',').map(t => t.trim()).filter(Boolean) : undefined;

      const agentConfig: AgentRoutingConfig = {
        id: formData.id || `agent-${Date.now()}`,
        name: formData.name || 'New Agent',
        description: formData.description || '',
        systemPrompt: formData.systemPrompt || '',
        tools,
        bindings,
        tags,
        enabled: formData.enabled !== false,
        modelOverride: formData.modelOverride,
      };

      onSave(agentConfig);
    } catch (error) {
      logger.error('Failed to parse agent config', error);
    }
  };

  return (
    <div className="fixed inset-0 z-60 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onCancel} />
      <div className="relative w-full max-w-xl max-h-[80vh] bg-zinc-900 rounded-xl border border-zinc-800 shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
          <h3 className="text-lg font-semibold text-zinc-100">
            {isNew ? '创建 Agent' : '编辑 Agent'}
          </h3>
          <button onClick={onCancel} className="text-zinc-400 hover:text-zinc-200">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-4 overflow-y-auto max-h-[60vh]">
          {isNew && (
            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-1">ID</label>
              <Input
                value={formData.id || ''}
                onChange={(e) => setFormData({ ...formData, id: e.target.value })}
                placeholder="agent-my-custom"
                inputSize="sm"
              />
              <p className="text-xs text-zinc-500 mt-1">唯一标识符，创建后不可修改</p>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1">名称</label>
            <Input
              value={formData.name || ''}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              placeholder="My Custom Agent"
              inputSize="sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1">描述</label>
            <Input
              value={formData.description || ''}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              placeholder="用于处理特定类型任务的 Agent"
              inputSize="sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1">System Prompt</label>
            <textarea
              value={formData.systemPrompt || ''}
              onChange={(e) => setFormData({ ...formData, systemPrompt: e.target.value })}
              placeholder="你是一个专门处理..."
              rows={6}
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1">工具列表（逗号分隔）</label>
            <Input
              value={toolsText}
              onChange={(e) => setToolsText(e.target.value)}
              placeholder="read_file, write_file, bash"
              inputSize="sm"
            />
            <p className="text-xs text-zinc-500 mt-1">留空表示使用所有可用工具</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1">绑定规则 (JSON)</label>
            <textarea
              value={bindingsText}
              onChange={(e) => setBindingsText(e.target.value)}
              placeholder='[{"type": "keyword", "match": {"keywords": ["review", "检查"]}}]'
              rows={4}
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 font-mono placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1">标签（逗号分隔）</label>
            <Input
              value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
              placeholder="code, review, quality"
              inputSize="sm"
            />
          </div>
        </div>

        <div className="px-6 py-4 border-t border-zinc-800 flex justify-end gap-3">
          <Button variant="ghost" onClick={onCancel}>
            取消
          </Button>
          <Button variant="primary" onClick={handleSave} leftIcon={<Check className="w-4 h-4" />}>
            保存
          </Button>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// Main Component
// ============================================================================

export const AgentsSettings: React.FC = () => {
  const [agents, setAgents] = useState<AgentRoutingConfig[]>([]);
  const [defaultAgentId, setDefaultAgentId] = useState<string>('default');
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [editingAgent, setEditingAgent] = useState<AgentRoutingConfig | null>(null);
  const [isNewAgent, setIsNewAgent] = useState(false);

  // Load agents
  const loadAgents = useCallback(async () => {
    try {
      setLoading(true);
      const result = await invokeAgentIPC<{
        agents: AgentRoutingConfig[];
        defaultAgentId: string;
      }>(IPC_CHANNELS.AGENT_ROUTING_LIST);
      if (result) {
        setAgents(result.agents);
        setDefaultAgentId(result.defaultAgentId);
      }
    } catch (err) {
      logger.error('Failed to load agents', err);
      setMessage({ type: 'error', text: '加载失败' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAgents();
  }, [loadAgents]);

  // Clear message after delay
  useEffect(() => {
    if (message) {
      const timer = setTimeout(() => setMessage(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  // Handlers
  const handleSaveAgent = async (agent: AgentRoutingConfig) => {
    try {
      await invokeAgentIPC(IPC_CHANNELS.AGENT_ROUTING_UPSERT, agent);
      setMessage({ type: 'success', text: isNewAgent ? 'Agent 创建成功' : 'Agent 更新成功' });
      setEditingAgent(null);
      setIsNewAgent(false);
      await loadAgents();
    } catch (err) {
      logger.error('Failed to save agent', err);
      setMessage({ type: 'error', text: '保存失败' });
    }
  };

  const handleDeleteAgent = async (id: string) => {
    if (!confirm('确定要删除这个 Agent 吗？')) return;
    try {
      await invokeAgentIPC(IPC_CHANNELS.AGENT_ROUTING_DELETE, id);
      setMessage({ type: 'success', text: 'Agent 已删除' });
      await loadAgents();
    } catch (err) {
      logger.error('Failed to delete agent', err);
      setMessage({ type: 'error', text: '删除失败' });
    }
  };

  const handleToggleEnabled = async (id: string, enabled: boolean) => {
    try {
      await invokeAgentIPC(IPC_CHANNELS.AGENT_ROUTING_SET_ENABLED, id, enabled);
      await loadAgents();
    } catch (err) {
      logger.error('Failed to toggle agent', err);
      setMessage({ type: 'error', text: '操作失败' });
    }
  };

  const handleSetDefault = async (id: string) => {
    try {
      await invokeAgentIPC(IPC_CHANNELS.AGENT_ROUTING_SET_DEFAULT, id);
      setMessage({ type: 'success', text: '已设为默认 Agent' });
      await loadAgents();
    } catch (err) {
      logger.error('Failed to set default agent', err);
      setMessage({ type: 'error', text: '操作失败' });
    }
  };

  const handleCreateNew = () => {
    setEditingAgent({
      id: '',
      name: '',
      description: '',
      systemPrompt: '',
      enabled: true,
      bindings: [],
    });
    setIsNewAgent(true);
  };

  // Loading state
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-zinc-400" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-zinc-100 mb-2">Agent 路由</h3>
          <p className="text-xs text-zinc-400">
            配置多个 Agent，根据上下文自动选择最合适的 Agent 处理任务。
          </p>
        </div>
        <Button
          size="sm"
          variant="primary"
          onClick={handleCreateNew}
          leftIcon={<Plus className="w-4 h-4" />}
        >
          新建 Agent
        </Button>
      </div>

      {/* Message */}
      {message && (
        <div
          className={`flex items-center gap-2 p-3 rounded-lg ${
            message.type === 'success'
              ? 'bg-emerald-500/10 text-emerald-400'
              : 'bg-red-500/10 text-red-400'
          }`}
        >
          {message.type === 'success' ? (
            <Check className="w-4 h-4" />
          ) : (
            <AlertCircle className="w-4 h-4" />
          )}
          <span className="text-sm">{message.text}</span>
        </div>
      )}

      {/* Agent List */}
      <div className="space-y-3">
        {agents.length === 0 ? (
          <div className="bg-zinc-800/50 rounded-lg p-6 text-center">
            <Bot className="w-8 h-8 text-zinc-500 mx-auto mb-2" />
            <p className="text-sm text-zinc-400">还没有配置任何 Agent</p>
            <p className="text-xs text-zinc-500 mt-1">
              点击"新建 Agent"创建你的第一个自定义 Agent
            </p>
          </div>
        ) : (
          agents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              isDefault={agent.id === defaultAgentId}
              onEdit={setEditingAgent}
              onDelete={handleDeleteAgent}
              onToggleEnabled={handleToggleEnabled}
              onSetDefault={handleSetDefault}
            />
          ))
        )}
      </div>

      {/* Info Box */}
      <div className="bg-zinc-800/50 rounded-lg p-4">
        <h4 className="text-sm font-medium text-zinc-100 mb-2">关于 Agent 路由</h4>
        <p className="text-xs text-zinc-400 leading-relaxed">
          Agent 路由允许你定义多个专门化的 Agent，每个 Agent 有自己的 System Prompt 和工具集。
          系统会根据绑定规则自动选择最合适的 Agent。绑定类型包括：
        </p>
        <ul className="mt-2 text-xs text-zinc-400 space-y-1 list-disc list-inside">
          <li><span className="text-zinc-300">keyword</span>: 根据消息中的关键词匹配</li>
          <li><span className="text-zinc-300">directory</span>: 根据工作目录匹配</li>
          <li><span className="text-zinc-300">file_pattern</span>: 根据当前文件模式匹配</li>
          <li><span className="text-zinc-300">intent</span>: 根据用户意图匹配（语义分析）</li>
          <li><span className="text-zinc-300">always</span>: 始终激活（低优先级后备）</li>
        </ul>
      </div>

      {/* Edit Modal */}
      {editingAgent && (
        <AgentEditModal
          agent={editingAgent}
          isNew={isNewAgent}
          onSave={handleSaveAgent}
          onCancel={() => {
            setEditingAgent(null);
            setIsNewAgent(false);
          }}
        />
      )}
    </div>
  );
};
