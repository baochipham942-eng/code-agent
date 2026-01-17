// ============================================================================
// GenerationBadge - Display and Switch Generations
// ============================================================================

import React, { useState, useEffect } from 'react';
import { useAppStore } from '../stores/appStore';
import { ChevronDown, Zap, Layers, Brain, Sparkles, Database, Monitor, Users, Dna } from 'lucide-react';
import type { Generation, GenerationId } from '@shared/types';
import { IPC_CHANNELS } from '@shared/ipc';

// Generation configurations with icons and core tools (only new tools in each generation)
const generationConfigs: Record<string, {
  icon: React.ReactNode;
  color: string;
  coreTools: string[];  // Only new tools introduced in this generation
  theme: string;        // Theme/focus of this generation
}> = {
  gen1: {
    icon: <Zap className="w-3.5 h-3.5" />,
    color: 'text-green-400 bg-green-500/10',
    coreTools: ['bash', 'read_file', 'write_file', 'edit_file'],
    theme: '基础文件操作',
  },
  gen2: {
    icon: <Layers className="w-3.5 h-3.5" />,
    color: 'text-blue-400 bg-blue-500/10',
    coreTools: ['glob', 'grep', 'list_directory'],
    theme: '搜索与导航',
  },
  gen3: {
    icon: <Brain className="w-3.5 h-3.5" />,
    color: 'text-purple-400 bg-purple-500/10',
    coreTools: ['task', 'todo_write', 'ask_user_question'],
    theme: '子代理与规划',
  },
  gen4: {
    icon: <Sparkles className="w-3.5 h-3.5" />,
    color: 'text-orange-400 bg-orange-500/10',
    coreTools: ['skill', 'web_fetch'],
    theme: '技能系统与网络',
  },
  gen5: {
    icon: <Database className="w-3.5 h-3.5" />,
    color: 'text-cyan-400 bg-cyan-500/10',
    coreTools: ['memory_store', 'memory_search', 'code_index'],
    theme: 'RAG 与长期记忆',
  },
  gen6: {
    icon: <Monitor className="w-3.5 h-3.5" />,
    color: 'text-pink-400 bg-pink-500/10',
    coreTools: ['screenshot', 'computer_use', 'browser_navigate', 'browser_action'],
    theme: 'Computer Use',
  },
  gen7: {
    icon: <Users className="w-3.5 h-3.5" />,
    color: 'text-indigo-400 bg-indigo-500/10',
    coreTools: ['spawn_agent', 'agent_message', 'workflow_orchestrate'],
    theme: '多代理协同',
  },
  gen8: {
    icon: <Dna className="w-3.5 h-3.5" />,
    color: 'text-rose-400 bg-rose-500/10',
    coreTools: ['strategy_optimize', 'tool_create', 'self_evaluate', 'learn_pattern'],
    theme: '自我进化',
  },
};

// Default generations (will be loaded from main process)
// 版本号对应代际：Gen1=v1.0, Gen2=v2.0, ..., Gen8=v8.0
const defaultGenerations: Generation[] = [
  {
    id: 'gen1',
    name: 'Generation 1',
    version: 'v1.0',
    description: 'Basic: bash, read_file, write_file, edit_file',
    tools: ['bash', 'read_file', 'write_file', 'edit_file'],
    systemPrompt: '',
    promptMetadata: { lineCount: 0, toolCount: 4, ruleCount: 0 },
  },
  {
    id: 'gen2',
    name: 'Generation 2',
    version: 'v2.0',
    description: '+ glob, grep, list_directory, MCP',
    tools: ['bash', 'read_file', 'write_file', 'edit_file', 'glob', 'grep', 'list_directory'],
    systemPrompt: '',
    promptMetadata: { lineCount: 0, toolCount: 7, ruleCount: 0 },
  },
  {
    id: 'gen3',
    name: 'Generation 3',
    version: 'v3.0',
    description: '+ task, todo_write, ask_user, Plan Mode',
    tools: ['bash', 'read_file', 'write_file', 'edit_file', 'glob', 'grep', 'list_directory', 'task', 'todo_write', 'ask_user_question'],
    systemPrompt: '',
    promptMetadata: { lineCount: 0, toolCount: 10, ruleCount: 0 },
  },
  {
    id: 'gen4',
    name: 'Generation 4',
    version: 'v4.0',
    description: '+ skill, web_fetch, hooks, LSP',
    tools: ['bash', 'read_file', 'write_file', 'edit_file', 'glob', 'grep', 'list_directory', 'task', 'todo_write', 'ask_user_question', 'skill', 'web_fetch'],
    systemPrompt: '',
    promptMetadata: { lineCount: 0, toolCount: 12, ruleCount: 0 },
  },
  {
    id: 'gen5',
    name: 'Generation 5',
    version: 'v5.0',
    description: '+ memory_store, memory_search, code_index, RAG',
    tools: ['bash', 'read_file', 'write_file', 'edit_file', 'glob', 'grep', 'list_directory', 'task', 'todo_write', 'ask_user_question', 'skill', 'web_fetch', 'memory_store', 'memory_search', 'code_index'],
    systemPrompt: '',
    promptMetadata: { lineCount: 0, toolCount: 17, ruleCount: 0 },
  },
  {
    id: 'gen6',
    name: 'Generation 6',
    version: 'v6.0',
    description: '+ screenshot, computer_use, browser_action (Computer Use)',
    tools: ['bash', 'read_file', 'write_file', 'edit_file', 'glob', 'grep', 'list_directory', 'task', 'todo_write', 'ask_user_question', 'skill', 'web_fetch', 'memory_store', 'memory_search', 'code_index', 'screenshot', 'computer_use', 'browser_navigate', 'browser_action'],
    systemPrompt: '',
    promptMetadata: { lineCount: 0, toolCount: 21, ruleCount: 0 },
  },
  {
    id: 'gen7',
    name: 'Generation 7',
    version: 'v7.0',
    description: '+ spawn_agent, agent_message, workflow_orchestrate (Multi-Agent)',
    tools: ['bash', 'read_file', 'write_file', 'edit_file', 'glob', 'grep', 'list_directory', 'task', 'todo_write', 'ask_user_question', 'skill', 'web_fetch', 'memory_store', 'memory_search', 'code_index', 'screenshot', 'computer_use', 'browser_navigate', 'browser_action', 'spawn_agent', 'agent_message', 'workflow_orchestrate'],
    systemPrompt: '',
    promptMetadata: { lineCount: 0, toolCount: 24, ruleCount: 0 },
  },
  {
    id: 'gen8',
    name: 'Generation 8',
    version: 'v8.0',
    description: '+ strategy_optimize, tool_create, self_evaluate, learn_pattern (Self-Evolution)',
    tools: ['bash', 'read_file', 'write_file', 'edit_file', 'glob', 'grep', 'list_directory', 'task', 'todo_write', 'ask_user_question', 'skill', 'web_fetch', 'memory_store', 'memory_search', 'code_index', 'screenshot', 'computer_use', 'browser_navigate', 'browser_action', 'spawn_agent', 'agent_message', 'workflow_orchestrate', 'strategy_optimize', 'tool_create', 'self_evaluate', 'learn_pattern'],
    systemPrompt: '',
    promptMetadata: { lineCount: 0, toolCount: 28, ruleCount: 0 },
  },
];

export const GenerationBadge: React.FC = () => {
  const { currentGeneration, setCurrentGeneration } = useAppStore();
  const [showDropdown, setShowDropdown] = useState(false);
  const [generations, setGenerations] = useState<Generation[]>(defaultGenerations);

  const config = generationConfigs[currentGeneration.id] || generationConfigs.gen1;

  // Load generations from main process on mount
  useEffect(() => {
    const loadGenerations = async () => {
      try {
        console.log('[GenerationBadge] Loading generations from IPC...');
        const gens = await window.electronAPI?.invoke(IPC_CHANNELS.GENERATION_LIST);
        console.log('[GenerationBadge] Received generations:', gens?.length, gens?.map((g: Generation) => g.id));
        if (gens && gens.length > 0) {
          setGenerations(gens);
        } else {
          console.log('[GenerationBadge] Using default generations:', defaultGenerations.length);
        }
      } catch (error) {
        console.error('[GenerationBadge] Failed to load generations:', error);
      }
    };
    loadGenerations();
  }, []);

  const handleSelect = async (gen: Generation) => {
    setShowDropdown(false);
    try {
      // Switch generation in main process first
      const switched = await window.electronAPI?.invoke(IPC_CHANNELS.GENERATION_SWITCH, gen.id as GenerationId);
      if (switched) {
        setCurrentGeneration(switched);
        console.log(`[GenerationBadge] Switched to ${switched.name}`);
      }
    } catch (error) {
      console.error('Failed to switch generation:', error);
      // Fallback to local state update
      setCurrentGeneration(gen);
    }
  };

  return (
    <div className="relative">
      {/* Badge Button - 格式: Gen X vX.0 */}
      <button
        onClick={() => setShowDropdown(!showDropdown)}
        className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm transition-colors ${config.color}`}
      >
        {config.icon}
        <span className="font-medium">Gen {currentGeneration.id.replace('gen', '')}</span>
        <span className="text-xs opacity-70">{currentGeneration.version}</span>
        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showDropdown ? 'rotate-180' : ''}`} />
      </button>

      {/* Dropdown */}
      {showDropdown && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-10"
            onClick={() => setShowDropdown(false)}
          />

          {/* Menu */}
          <div className="absolute top-full left-0 mt-1 w-[520px] bg-zinc-800 rounded-lg shadow-xl border border-zinc-700 z-20 overflow-hidden animate-fadeIn">
            {/* Header */}
            <div className="px-3 py-2 border-b border-zinc-700 bg-zinc-800">
              <span className="text-xs font-medium text-zinc-400">选择代际</span>
            </div>

            {/* Generation List */}
            <div className="p-2 max-h-[400px] overflow-y-auto scrollbar-thin scrollbar-thumb-zinc-600 scrollbar-track-transparent">
              {generations.map((gen) => {
                const genConfig = generationConfigs[gen.id];
                const isSelected = currentGeneration.id === gen.id;
                const genNumber = parseInt(gen.id.replace('gen', ''));

                return (
                  <button
                    key={gen.id}
                    onClick={() => handleSelect(gen)}
                    className={`w-full flex items-start gap-3 p-3 rounded-lg transition-colors text-left ${
                      isSelected
                        ? 'bg-zinc-700'
                        : 'hover:bg-zinc-700/50'
                    }`}
                  >
                    <div className={`p-2 rounded-lg ${genConfig.color}`}>
                      {genConfig.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-zinc-100">
                          {gen.name}
                        </span>
                        <span className="text-xs text-zinc-500">
                          {gen.version}
                        </span>
                        <span className={`text-xs px-2 py-0.5 rounded-full ${genConfig.color}`}>
                          {genConfig.theme}
                        </span>
                        <span className="text-xs text-zinc-500">
                          共 {gen.tools.length} 工具
                        </span>
                      </div>
                      {/* 只展示本代核心新增工具 */}
                      <div className="flex flex-wrap gap-1 mt-2">
                        {genConfig.coreTools.map((tool) => (
                          <span
                            key={tool}
                            className={`text-xs px-1.5 py-0.5 rounded ${genConfig.color}`}
                          >
                            {tool}
                          </span>
                        ))}
                      </div>
                      {/* 继承的工具数量提示 */}
                      {genNumber > 1 && (
                        <p className="text-xs text-zinc-600 mt-1.5">
                          继承 Gen 1-{genNumber - 1} 的 {gen.tools.length - genConfig.coreTools.length} 个工具
                        </p>
                      )}
                    </div>
                    {isSelected && (
                      <div className="w-2 h-2 rounded-full bg-blue-500 mt-2" />
                    )}
                  </button>
                );
              })}
            </div>

            {/* Footer with comparison hint */}
            <div className="px-4 py-2 bg-zinc-900/50 border-t border-zinc-700">
              <p className="text-xs text-zinc-500">
                切换代际以比较 AI Agent 能力演进
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
