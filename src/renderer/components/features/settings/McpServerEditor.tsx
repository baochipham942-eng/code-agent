// ============================================================================
// McpServerEditor - MCP 服务器添加/编辑对话框
// ============================================================================

import React, { useState, useCallback } from 'react';
import { Server, Terminal, Globe, Code, Plus, Trash2, Eye, EyeOff } from 'lucide-react';
import { Modal, ModalFooter, Input, Badge, Button } from '../../primitives';
import { useI18n } from '../../../hooks/useI18n';
import { MCP_SECRET_REF_PREFIX } from '@shared/constants';
import { isSensitiveMcpCredentialKey } from '@shared/security/mcpSecretKeys';

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

/** JSON 视图能读写的字段集合——与 configToJson / handleSave 的取值口径保持一致。 */
const JSON_EDITABLE_KEYS = ['name', 'type', 'command', 'args', 'env', 'url', 'headers'] as const;

export interface McpServerSaveSecrets {
  secretEnvKeys: string[];
  secretHeaderKeys: string[];
}

export type McpServerSaveOutcome = 'success' | 'cancelled' | 'error';

interface McpServerEditorProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (
    config: McpServerConfig,
    secrets?: McpServerSaveSecrets,
  ) => McpServerSaveOutcome | void | Promise<McpServerSaveOutcome | void>;
  onCancelInstall?: (serverName: string) => void | Promise<void>;
  /** 打开时预填的配置（推荐 MCP 一键连接入口使用） */
  initialConfig?: Partial<McpServerConfig>;
}

type ServerType = McpServerConfig['type'];
type ViewMode = 'form' | 'json';
type McpServerEditorText = ReturnType<typeof useI18n>['t']['settings']['mcp']['editor'];

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

// isSensitiveMcpCredentialKey 定义已下沉到 @shared/security/mcpSecretKeys（host 侧
// mcp_add_server 工具同款判定），此处重新导出以保持既有 import 面不变。
export { isSensitiveMcpCredentialKey };

function isMcpSecretReference(value: string): boolean {
  return value.startsWith(MCP_SECRET_REF_PREFIX);
}

function getMcpServerSaveSecrets(config: McpServerConfig): McpServerSaveSecrets | undefined {
  const secretEnvKeys = Object.entries(config.env || {})
    .filter(([key, value]) => isSensitiveMcpCredentialKey(key) && !isMcpSecretReference(value))
    .map(([key]) => key);
  const secretHeaderKeys = Object.entries(config.headers || {})
    .filter(([key, value]) => isSensitiveMcpCredentialKey(key) && !isMcpSecretReference(value))
    .map(([key]) => key);

  if (secretEnvKeys.length === 0 && secretHeaderKeys.length === 0) {
    return undefined;
  }

  return { secretEnvKeys, secretHeaderKeys };
}

function retainSavedSecretReferences(
  nextEntries: Record<string, string> | undefined,
  currentEntries: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!nextEntries || !currentEntries) {
    return nextEntries;
  }

  let retainedEntries = nextEntries;
  for (const [key, currentValue] of Object.entries(currentEntries)) {
    if (isMcpSecretReference(currentValue) && nextEntries[key] === '') {
      if (retainedEntries === nextEntries) {
        retainedEntries = { ...nextEntries };
      }
      retainedEntries[key] = currentValue;
    }
  }
  return retainedEntries;
}

function redactSecretReferences(
  entries: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!entries) {
    return entries;
  }

  return Object.fromEntries(
    Object.entries(entries).map(([key, value]) => [
      key,
      isMcpSecretReference(value) ? '' : value,
    ]),
  );
}

// ============================================================================
// Sub-components
// ============================================================================

/** Key-value pair editor for env vars / headers */
const KeyValueEditor: React.FC<{
  label: string;
  text: McpServerEditorText;
  entries: Record<string, string>;
  onChange: (entries: Record<string, string>) => void;
}> = ({ label, text, entries, onChange }) => {
  const pairs = Object.entries(entries);
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(() => new Set());
  const savedSecretReferences = React.useRef(new Map<string, string>());

  React.useEffect(() => {
    for (const [key, value] of Object.entries(entries)) {
      if (isMcpSecretReference(value)) {
        savedSecretReferences.current.set(key, value);
      }
    }
  }, [entries]);

  const handleAdd = () => {
    onChange({ ...entries, '': '' });
  };

  const handleRemove = (key: string) => {
    const next = { ...entries };
    delete next[key];
    savedSecretReferences.current.delete(key);
    onChange(next);
  };

  const handleKeyChange = (oldKey: string, newKey: string) => {
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(entries)) {
      next[k === oldKey ? newKey : k] = v;
    }
    const savedReference = savedSecretReferences.current.get(oldKey);
    if (savedReference) {
      savedSecretReferences.current.delete(oldKey);
      savedSecretReferences.current.set(newKey, savedReference);
    }
    onChange(next);
  };

  const toggleReveal = (key: string, rowKey: string) => {
    const revealKey = key || rowKey;
    setRevealedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(revealKey)) {
        next.delete(revealKey);
      } else {
        next.add(revealKey);
      }
      return next;
    });
  };

  const handleValueChange = (key: string, value: string) => {
    const savedReference = savedSecretReferences.current.get(key);
    onChange({
      ...entries,
      [key]: value === '' && savedReference ? savedReference : value,
    });
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
          {text.add}
        </button>
      </div>
      {pairs.length === 0 && (
        <p className="text-xs text-zinc-500 italic">{text.empty}</p>
      )}
      {pairs.map(([key, value], idx) => {
        const rowKey = `${label}:${idx}`;
        const sensitive = isSensitiveMcpCredentialKey(key);
        const revealKey = key || rowKey;
        const revealed = revealedKeys.has(revealKey);
        const savedReference = isMcpSecretReference(value);
        return (
          <div key={idx} className="flex items-center gap-2">
            <input
              type="text"
              value={key}
              onChange={(e) => handleKeyChange(key, e.target.value)}
              placeholder="Key"
              className="flex-1 bg-zinc-700 border border-zinc-600 rounded-lg px-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-500 focus:outline-hidden focus:border-zinc-500"
            />
            <div className="flex-1 flex items-center gap-1">
              <input
                type={(sensitive || savedReference) && !revealed ? 'password' : 'text'}
                value={savedReference ? '' : value}
                onChange={(e) => handleValueChange(key, e.target.value)}
                placeholder={savedReference ? '••••••••' : 'Value'}
                autoComplete="off"
                spellCheck={false}
                className="min-w-0 flex-1 bg-zinc-700 border border-zinc-600 rounded-lg px-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-500 focus:outline-hidden focus:border-zinc-500"
              />
              {savedReference && (
                <span className="shrink-0 text-[11px] text-badge-success">
                  {text.savedCredentialHint}
                </span>
              )}
              {sensitive && !savedReference && (
                <button
                  type="button"
                  onClick={() => toggleReveal(key, rowKey)}
                  aria-label={revealed ? text.hideSensitive : text.showSensitive}
                  className="p-1 text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                  {revealed ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => handleRemove(key)}
              className="p-1 text-zinc-500 hover:text-badge-danger transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })}
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
  onCancelInstall,
  initialConfig,
}) => {
  const { t } = useI18n();
  const editorText = t.settings.mcp.editor;
  const [config, setConfig] = useState<McpServerConfig>(() => (
    initialConfig ? { ...EMPTY_CONFIG, ...initialConfig } : { ...EMPTY_CONFIG }
  ));
  const [viewMode, setViewMode] = useState<ViewMode>('form');
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [installState, setInstallState] = useState<'idle' | 'installing' | 'cancelling'>('idle');

  // JSON 视图只认连接配置字段，其余（enabled/lazyLoad、从别家客户端配置文件粘来的扩展键…）
  // 保存时会被丢掉。粘贴外部配置是常见用法，静默丢弃会让用户以为写进去的设置生效了，
  // 所以这里当场把被忽略的键列出来——只提示，不改保存语义（粘贴不应等于自动启用）。
  const ignoredJsonKeys = React.useMemo(() => {
    if (viewMode !== 'json' || !jsonText.trim()) return [];
    try {
      const parsed: unknown = JSON.parse(jsonText);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [];
      return Object.keys(parsed as Record<string, unknown>)
        .filter((key) => !(JSON_EDITABLE_KEYS as readonly string[]).includes(key));
    } catch {
      return [];
    }
  }, [viewMode, jsonText]);

  // 打开时应用预填配置（用于推荐 MCP 的"连接"入口）
  React.useEffect(() => {
    if (isOpen) {
      setConfig(initialConfig ? { ...EMPTY_CONFIG, ...initialConfig } : { ...EMPTY_CONFIG });
      setInstallState('idle');
    }
  }, [isOpen, initialConfig]);

  // Reset state when opening
  const handleClose = useCallback(() => {
    if (installState !== 'idle') return;
    setConfig({ ...EMPTY_CONFIG });
    setViewMode('form');
    setJsonText('');
    setJsonError(null);
    onClose();
  }, [installState, onClose]);

  // Build JSON from config for the JSON view
  const configToJson = useCallback((c: McpServerConfig): string => {
    const obj: Record<string, unknown> = {
      name: c.name,
      type: c.type,
    };
    if (c.type === 'stdio') {
      obj.command = c.command || '';
      if (c.args && c.args.length > 0) obj.args = c.args;
      if (c.env && Object.keys(c.env).length > 0) obj.env = redactSecretReferences(c.env);
    } else {
      obj.url = c.url || '';
      if (c.headers && Object.keys(c.headers).length > 0) obj.headers = redactSecretReferences(c.headers);
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
          env: retainSavedSecretReferences(parsed.env, config.env) || {},
          url: parsed.url || '',
          headers: retainSavedSecretReferences(parsed.headers, config.headers) || {},
        });
        setJsonError(null);
      } catch {
        // Keep JSON view if parse fails
        setJsonError(editorText.jsonError);
        return;
      }
    }
    setViewMode(mode);
  }, [config, jsonText, configToJson, editorText.jsonError]);

  // Validation
  const isValid = useCallback((): boolean => {
    if (!config.name.trim()) return false;
    if (config.type === 'stdio' && !config.command?.trim()) return false;
    if ((config.type === 'sse' || config.type === 'http') && !config.url?.trim()) return false;
    return true;
  }, [config]);

  const saveConfig = useCallback(async (nextConfig: McpServerConfig) => {
    const secrets = getMcpServerSaveSecrets(nextConfig);
    setInstallState('installing');
    try {
      const outcome = secrets
        ? await onSave(nextConfig, secrets)
        : await onSave(nextConfig);
      if (outcome === 'cancelled' || outcome === 'error') {
        setInstallState('idle');
        return;
      }
      setInstallState('idle');
      handleClose();
    } catch {
      setInstallState('idle');
    }
  }, [handleClose, onSave]);

  const handleSave = useCallback(async () => {
    // If in JSON mode, parse first
    if (viewMode === 'json') {
      try {
        const parsed = JSON.parse(jsonText) as McpServerConfig;
        const nextConfig: McpServerConfig = {
          name: parsed.name || '',
          type: parsed.type || 'stdio',
          command: parsed.command,
          args: parsed.args,
          env: retainSavedSecretReferences(parsed.env, config.env),
          url: parsed.url,
          headers: retainSavedSecretReferences(parsed.headers, config.headers),
        };
        await saveConfig(nextConfig);
      } catch {
        setJsonError(editorText.jsonSaveError);
        return;
      }
    } else {
      await saveConfig(config);
    }
  }, [viewMode, jsonText, config, saveConfig, editorText.jsonSaveError]);

  const handleCancelInstall = useCallback(() => {
    if (installState !== 'installing') return;
    setInstallState('cancelling');
    void onCancelInstall?.(config.name.trim());
  }, [config.name, installState, onCancelInstall]);

  const updateConfig = useCallback(<K extends keyof McpServerConfig>(key: K, value: McpServerConfig[K]) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  }, []);

  return (
    <Modal
      isOpen={isOpen}
      onClose={installState === 'idle' ? handleClose : handleCancelInstall}
      title={editorText.title}
      size="lg"
      headerIcon={<Server className="w-5 h-5 text-indigo-400" />}
      footer={
        installState === 'idle' ? (
          <ModalFooter
            cancelText={editorText.cancel}
            confirmText={editorText.save}
            onCancel={handleClose}
            onConfirm={() => { void handleSave(); }}
            confirmDisabled={viewMode === 'form' && !isValid()}
            confirmColorClass="bg-indigo-600 hover:bg-indigo-500"
          />
        ) : (
          <div
            data-testid="mcp-install-state"
            data-state={installState}
            className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row"
          >
            {installState === 'installing' && (
              <Button variant="ghost" onClick={handleCancelInstall}>
                {editorText.cancelInstall}
              </Button>
            )}
            <Button variant="secondary" disabled loading>
              {installState === 'installing' ? editorText.installing : editorText.cancelling}
            </Button>
          </div>
        )
      }
    >
      <div className="space-y-5">
        {/* Server Name */}
        <div>
          <label className="block text-xs font-medium text-zinc-400 mb-1.5">{editorText.serverName}</label>
          <Input
            value={config.name}
            onChange={(e) => updateConfig('name', e.target.value)}
            placeholder={editorText.serverNamePlaceholder}
            inputSize="sm"
          />
        </div>

        {/* Type Selector (pills) */}
        <div>
          <label className="block text-xs font-medium text-zinc-400 mb-1.5">{editorText.transportType}</label>
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
                  {st.value === 'sse' && (
                    <Badge className="border-zinc-700 bg-zinc-800 text-[10px] font-normal text-zinc-400">
                      {editorText.sseLegacyBadge}
                    </Badge>
                  )}
                </button>
              );
            })}
          </div>
          {config.type === 'sse' && (
            <p className="mt-1.5 text-xs text-zinc-500">{editorText.sseLegacyNote}</p>
          )}
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
            {editorText.form}
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
                  <label className="block text-xs font-medium text-zinc-400 mb-1.5">{editorText.command}</label>
                  <Input
                    value={config.command || ''}
                    onChange={(e) => updateConfig('command', e.target.value)}
                    placeholder={editorText.commandPlaceholder}
                    inputSize="sm"
                  />
                </div>

                {/* Args */}
                <div>
                  <label className="block text-xs font-medium text-zinc-400 mb-1.5">
                    {editorText.args} <span className="text-zinc-500">{editorText.commaSeparated}</span>
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
                    placeholder={editorText.argsPlaceholder}
                    inputSize="sm"
                  />
                </div>

                {/* Env */}
                <KeyValueEditor
                  label={editorText.env}
                  text={editorText}
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
                    placeholder={config.type === 'sse' ? editorText.urlPlaceholderSse : editorText.urlPlaceholderHttp}
                    inputSize="sm"
                  />
                </div>

                {/* Headers */}
                <KeyValueEditor
                  label={editorText.headers}
                  text={editorText}
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
              className="w-full h-48 bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-3 text-xs text-zinc-200 font-mono focus:outline-hidden focus:border-zinc-600 resize-none"
              spellCheck={false}
            />
            {jsonError && (
              <p className="text-xs text-badge-danger">{jsonError}</p>
            )}
            {ignoredJsonKeys.length > 0 && (
              <p className="text-xs text-amber-400">
                {editorText.jsonIgnoredKeys.replace('{keys}', ignoredJsonKeys.join(', '))}
              </p>
            )}
            <p className="text-xs text-zinc-500">
              {editorText.jsonHint}
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
};
