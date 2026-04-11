// ============================================================================
// McpServerEditor - MCP 服务器添加/编辑对话框
// ============================================================================

import React, { useState, useCallback } from 'react';
import { Server, Terminal, Globe, Code, Plus, Trash2 } from 'lucide-react';
import { Modal, ModalFooter, Button, Input } from '../../primitives';

// ============================================================================
// Types
// ============================================================================

export interface McpServerConfig {
  name: string;
  type: 'stdio' | 'sse' | 'http';
  // stdio fields
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // sse/http fields
  url?: string;
  headers?: Record<string, string>;
}

interface McpServerEditorProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (config: McpServerConfig) => void;
}

type ServerType = McpServerConfig['type'];
type ViewMode = 'form' | 'json';

// ============================================================================
// Constants
// ============================================================================

const SERVER_TYPES: { value: ServerType; label: string; icon: React.ReactNode }[] = [
  { value: 'stdio', label: 'stdio', icon: <Terminal className="w-3.5 h-3.5" /> },
  { value: 'sse', label: 'SSE', icon: <Globe className="w-3.5 h-3.5" /> },
  { value: 'http', label: 'HTTP', icon: <Globe className="w-3.5 h-3.5" /> },
];

const EMPTY_CONFIG: McpServerConfig = {
  name: '',
  type: 'stdio',
  command: '',
  args: [],
  env: {},
  url: '',
  headers: {},
};

// ============================================================================
// Sub-components
// ============================================================================

/** Key-value pair editor for env vars / headers */
const KeyValueEditor: React.FC<{
  label: string;
  entries: Record<string, string>;
  onChange: (entries: Record<string, string>) => void;
}> = ({ label, entries, onChange }) => {
  const pairs = Object.entries(entries);

  const handleAdd = () => {
    onChange({ ...entries, '': '' });
  };

  const handleRemove = (key: string) => {
    const next = { ...entries };
    delete next[key];
    onChange(next);
  };

  const handleKeyChange = (oldKey: string, newKey: string) => {
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(entries)) {
      next[k === oldKey ? newKey : k] = v;
    }
    onChange(next);
  };

  const handleValueChange = (key: string, value: string) => {
    onChange({ ...entries, [key]: value });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-zinc-400">{label}</label>
        <button
          type="button"
          onClick={handleAdd}
          className="flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
        >
          <Plus className="w-3 h-3" />
          添加
        </button>
      </div>
      {pairs.length === 0 && (
        <p className="text-xs text-zinc-500 italic">暂无条目</p>
      )}
      {pairs.map(([key, value], idx) => (
        <div key={idx} className="flex items-center gap-2">
          <input
            type="text"
            value={key}
            onChange={(e) => handleKeyChange(key, e.target.value)}
            placeholder="Key"
            className="flex-1 bg-zinc-700 border border-zinc-600 rounded-lg px-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:border-zinc-500"
          />
          <input
            type="text"
            value={value}
            onChange={(e) => handleValueChange(key, e.target.value)}
            placeholder="Value"
            className="flex-1 bg-zinc-700 border border-zinc-600 rounded-lg px-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:border-zinc-500"
          />
          <button
            type="button"
            onClick={() => handleRemove(key)}
            className="p-1 text-zinc-500 hover:text-red-400 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
};

// ============================================================================
// Main Component
// ============================================================================

export const McpServerEditor: React.FC<McpServerEditorProps> = ({
  isOpen,
  onClose,
  onSave,
}) => {
  const [config, setConfig] = useState<McpServerConfig>({ ...EMPTY_CONFIG });
  const [viewMode, setViewMode] = useState<ViewMode>('form');
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);

  // Reset state when opening
  const handleClose = useCallback(() => {
    setConfig({ ...EMPTY_CONFIG });
    setViewMode('form');
    setJsonText('');
    setJsonError(null);
    onClose();
  }, [onClose]);

  // Build JSON from config for the JSON view
  const configToJson = useCallback((c: McpServerConfig): string => {
    const obj: Record<string, unknown> = {
      name: c.name,
      type: c.type,
    };
    if (c.type === 'stdio') {
      obj.command = c.command || '';
      if (c.args && c.args.length > 0) obj.args = c.args;
      if (c.env && Object.keys(c.env).length > 0) obj.env = c.env;
    } else {
      obj.url = c.url || '';
      if (c.headers && Object.keys(c.headers).length > 0) obj.headers = c.headers;
    }
    return JSON.stringify(obj, null, 2);
  }, []);

  // Switch between form and JSON views
  const handleViewModeChange = useCallback((mode: ViewMode) => {
    if (mode === 'json') {
      setJsonText(configToJson(config));
      setJsonError(null);
    } else {
      // Parse JSON back to config
      try {
        const parsed = JSON.parse(jsonText) as McpServerConfig;
        setConfig({
          name: parsed.name || '',
          type: parsed.type || 'stdio',
          command: parsed.command || '',
          args: parsed.args || [],
          env: parsed.env || {},
          url: parsed.url || '',
          headers: parsed.headers || {},
        });
        setJsonError(null);
      } catch {
        // Keep JSON view if parse fails
        setJsonError('JSON 格式错误');
        return;
      }
    }
    setViewMode(mode);
  }, [config, jsonText, configToJson]);

  // Validation
  const isValid = useCallback((): boolean => {
    if (!config.name.trim()) return false;
    if (config.type === 'stdio' && !config.command?.trim()) return false;
    if ((config.type === 'sse' || config.type === 'http') && !config.url?.trim()) return false;
    return true;
  }, [config]);

  const handleSave = useCallback(() => {
    // If in JSON mode, parse first
    if (viewMode === 'json') {
      try {
        const parsed = JSON.parse(jsonText) as McpServerConfig;
        onSave({
          name: parsed.name || '',
          type: parsed.type || 'stdio',
          command: parsed.command,
          args: parsed.args,
          env: parsed.env,
          url: parsed.url,
          headers: parsed.headers,
        });
      } catch {
        setJsonError('JSON 格式错误，无法保存');
        return;
      }
    } else {
      onSave(config);
    }
    handleClose();
  }, [viewMode, jsonText, config, onSave, handleClose]);

  const updateConfig = useCallback(<K extends keyof McpServerConfig>(key: K, value: McpServerConfig[K]) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  }, []);

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="添加 MCP 服务器"
      size="lg"
      headerIcon={<Server className="w-5 h-5 text-indigo-400" />}
      footer={
        <ModalFooter
          cancelText="取消"
          confirmText="保存"
          onCancel={handleClose}
          onConfirm={handleSave}
          confirmDisabled={viewMode === 'form' && !isValid()}
          confirmColorClass="bg-indigo-600 hover:bg-indigo-500"
        />
      }
    >
      <div className="space-y-5">
        {/* Server Name */}
        <div>
          <label className="block text-xs font-medium text-zinc-400 mb-1.5">服务器名称</label>
          <Input
            value={config.name}
            onChange={(e) => updateConfig('name', e.target.value)}
            placeholder="例如: filesystem, brave-search"
            inputSize="sm"
          />
        </div>

        {/* Type Selector (pills) */}
        <div>
          <label className="block text-xs font-medium text-zinc-400 mb-1.5">传输类型</label>
          <div className="flex items-center gap-0.5 p-0.5 bg-zinc-800 rounded-lg border border-zinc-700 w-fit">
            {SERVER_TYPES.map((st) => {
              const isActive = config.type === st.value;
              return (
                <button
                  key={st.value}
                  type="button"
                  onClick={() => updateConfig('type', st.value)}
                  className={`
                    flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium
                    transition-all duration-150
                    ${isActive
                      ? 'bg-indigo-500/20 text-indigo-400'
                      : 'text-zinc-500 hover:text-zinc-400 hover:bg-zinc-700/50'
                    }
                  `}
                >
                  {st.icon}
                  <span>{st.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* View Mode Toggle */}
        <div className="flex items-center gap-2 border-b border-zinc-700 pb-2">
          <button
            type="button"
            onClick={() => handleViewModeChange('form')}
            className={`text-xs px-2.5 py-1 rounded-md transition-colors ${
              viewMode === 'form'
                ? 'bg-zinc-700 text-zinc-200'
                : 'text-zinc-500 hover:text-zinc-400'
            }`}
          >
            表单
          </button>
          <button
            type="button"
            onClick={() => handleViewModeChange('json')}
            className={`flex items-center gap-1 text-xs px-2.5 py-1 rounded-md transition-colors ${
              viewMode === 'json'
                ? 'bg-zinc-700 text-zinc-200'
                : 'text-zinc-500 hover:text-zinc-400'
            }`}
          >
            <Code className="w-3 h-3" />
            JSON
          </button>
        </div>

        {/* Form View */}
        {viewMode === 'form' && (
          <div className="space-y-4">
            {config.type === 'stdio' ? (
              <>
                {/* Command */}
                <div>
                  <label className="block text-xs font-medium text-zinc-400 mb-1.5">命令</label>
                  <Input
                    value={config.command || ''}
                    onChange={(e) => updateConfig('command', e.target.value)}
                    placeholder="例如: npx, node, python"
                    inputSize="sm"
                  />
                </div>

                {/* Args */}
                <div>
                  <label className="block text-xs font-medium text-zinc-400 mb-1.5">
                    参数 <span className="text-zinc-500">（逗号分隔）</span>
                  </label>
                  <Input
                    value={(config.args || []).join(', ')}
                    onChange={(e) => {
                      const args = e.target.value
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean);
                      updateConfig('args', args);
                    }}
                    placeholder="例如: -y, @modelcontextprotocol/server-filesystem, /tmp"
                    inputSize="sm"
                  />
                </div>

                {/* Env */}
                <KeyValueEditor
                  label="环境变量"
                  entries={config.env || {}}
                  onChange={(env) => updateConfig('env', env)}
                />
              </>
            ) : (
              <>
                {/* URL */}
                <div>
                  <label className="block text-xs font-medium text-zinc-400 mb-1.5">URL</label>
                  <Input
                    value={config.url || ''}
                    onChange={(e) => updateConfig('url', e.target.value)}
                    placeholder={config.type === 'sse' ? 'http://localhost:3001/sse' : 'http://localhost:3001/mcp'}
                    inputSize="sm"
                  />
                </div>

                {/* Headers */}
                <KeyValueEditor
                  label="请求头"
                  entries={config.headers || {}}
                  onChange={(headers) => updateConfig('headers', headers)}
                />
              </>
            )}
          </div>
        )}

        {/* JSON View */}
        {viewMode === 'json' && (
          <div className="space-y-2">
            <textarea
              value={jsonText}
              onChange={(e) => {
                setJsonText(e.target.value);
                setJsonError(null);
              }}
              className="w-full h-48 bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-3 text-xs text-zinc-200 font-mono focus:outline-none focus:border-zinc-600 resize-none"
              spellCheck={false}
            />
            {jsonError && (
              <p className="text-xs text-red-400">{jsonError}</p>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
};
