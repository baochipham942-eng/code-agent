// ============================================================================
// ChannelsSettings - 多通道接入设置
// ============================================================================

import React, { useState, useEffect } from 'react';
import {
  Plus,
  Trash2,
  Edit,
  Power,
  PowerOff,
  Loader2,
  CheckCircle,
  AlertCircle,
  Globe,
  MessageSquare,
  Eye,
  EyeOff,
} from 'lucide-react';
import { useI18n } from '../../../../hooks/useI18n';
import { Button } from '../../../primitives';
import { createLogger } from '../../../../utils/logger';
import { IPC_CHANNELS } from '@shared/ipc';
import type {
  ChannelAccount,
  ChannelType,
  ChannelAccountConfig,
  HttpApiChannelConfig,
  FeishuChannelConfig,
} from '@shared/types/channel';

const logger = createLogger('ChannelsSettings');

// ============================================================================
// Types
// ============================================================================

interface ChannelTypeInfo {
  type: ChannelType;
  name: string;
  description?: string;
}

// ============================================================================
// Add/Edit Modal
// ============================================================================

interface ChannelModalProps {
  account?: ChannelAccount;
  channelTypes: ChannelTypeInfo[];
  onSave: (data: {
    name: string;
    type: ChannelType;
    config: ChannelAccountConfig;
  }) => void;
  onClose: () => void;
}

const ChannelModal: React.FC<ChannelModalProps> = ({
  account,
  channelTypes,
  onSave,
  onClose,
}) => {
  const [name, setName] = useState(account?.name || '');
  const [type, setType] = useState<ChannelType>(account?.type || 'http-api');
  const [showSecrets, setShowSecrets] = useState(false);

  // HTTP API 配置
  const [apiPort, setApiPort] = useState(
    (account?.config as HttpApiChannelConfig)?.port?.toString() || '8080'
  );
  const [apiKey, setApiKey] = useState(
    (account?.config as HttpApiChannelConfig)?.apiKey || crypto.randomUUID().replace(/-/g, '')
  );
  const [enableCors, setEnableCors] = useState(
    (account?.config as HttpApiChannelConfig)?.enableCors ?? true
  );

  // 飞书配置
  const [appId, setAppId] = useState(
    (account?.config as FeishuChannelConfig)?.appId || ''
  );
  const [appSecret, setAppSecret] = useState(
    (account?.config as FeishuChannelConfig)?.appSecret || ''
  );
  const [encryptKey, setEncryptKey] = useState(
    (account?.config as FeishuChannelConfig)?.encryptKey || ''
  );
  const [verificationToken, setVerificationToken] = useState(
    (account?.config as FeishuChannelConfig)?.verificationToken || ''
  );
  const [webhookPort, setWebhookPort] = useState(
    (account?.config as FeishuChannelConfig)?.webhookPort?.toString() || '3200'
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    let config: ChannelAccountConfig;

    if (type === 'http-api') {
      config = {
        type: 'http-api',
        port: parseInt(apiPort) || 8080,
        apiKey: apiKey || crypto.randomUUID().replace(/-/g, ''),
        enableCors,
      };
    } else if (type === 'feishu') {
      config = {
        type: 'feishu',
        appId,
        appSecret,
        encryptKey: encryptKey || undefined,
        verificationToken: verificationToken || undefined,
        useWebSocket: false, // 默认使用 Webhook 模式
        webhookPort: parseInt(webhookPort) || 3200,
      };
    } else {
      return;
    }

    onSave({ name, type, config });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-md bg-zinc-900 rounded-xl border border-zinc-800 p-6">
        <h3 className="text-lg font-semibold text-zinc-100 mb-4">
          {account ? '编辑通道' : '添加通道'}
        </h3>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* 名称 */}
          <div>
            <label className="block text-sm text-zinc-400 mb-1">名称</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-100 text-sm focus:outline-none focus:border-indigo-500"
              placeholder="例如: 测试 API"
              required
            />
          </div>

          {/* 类型 */}
          {!account && (
            <div>
              <label className="block text-sm text-zinc-400 mb-1">通道类型</label>
              <select
                value={type}
                onChange={(e) => setType(e.target.value as ChannelType)}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-100 text-sm focus:outline-none focus:border-indigo-500"
              >
                {channelTypes.map((ct) => (
                  <option key={ct.type} value={ct.type}>
                    {ct.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* HTTP API 配置 */}
          {type === 'http-api' && (
            <>
              <div>
                <label className="block text-sm text-zinc-400 mb-1">端口</label>
                <input
                  type="number"
                  value={apiPort}
                  onChange={(e) => setApiPort(e.target.value)}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-100 text-sm focus:outline-none focus:border-indigo-500"
                  placeholder="8080"
                  min={1}
                  max={65535}
                />
              </div>
              <div>
                <label className="block text-sm text-zinc-400 mb-1">
                  API Key
                  <button
                    type="button"
                    onClick={() => setShowSecrets(!showSecrets)}
                    className="ml-2 text-zinc-500 hover:text-zinc-300"
                  >
                    {showSecrets ? <EyeOff className="w-3 h-3 inline" /> : <Eye className="w-3 h-3 inline" />}
                  </button>
                </label>
                <input
                  type={showSecrets ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-100 text-sm focus:outline-none focus:border-indigo-500"
                  placeholder="留空自动生成"
                />
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="enableCors"
                  checked={enableCors}
                  onChange={(e) => setEnableCors(e.target.checked)}
                  className="rounded border-zinc-600"
                />
                <label htmlFor="enableCors" className="text-sm text-zinc-400">
                  启用 CORS
                </label>
              </div>
            </>
          )}

          {/* 飞书配置 */}
          {type === 'feishu' && (
            <>
              <div>
                <label className="block text-sm text-zinc-400 mb-1">App ID</label>
                <input
                  type="text"
                  value={appId}
                  onChange={(e) => setAppId(e.target.value)}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-100 text-sm focus:outline-none focus:border-indigo-500"
                  placeholder="cli_xxxxxxxxxx"
                  required
                />
              </div>
              <div>
                <label className="block text-sm text-zinc-400 mb-1">
                  App Secret
                  <button
                    type="button"
                    onClick={() => setShowSecrets(!showSecrets)}
                    className="ml-2 text-zinc-500 hover:text-zinc-300"
                  >
                    {showSecrets ? <EyeOff className="w-3 h-3 inline" /> : <Eye className="w-3 h-3 inline" />}
                  </button>
                </label>
                <input
                  type={showSecrets ? 'text' : 'password'}
                  value={appSecret}
                  onChange={(e) => setAppSecret(e.target.value)}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-100 text-sm focus:outline-none focus:border-indigo-500"
                  required
                />
              </div>
              <div>
                <label className="block text-sm text-zinc-400 mb-1">Encrypt Key (可选)</label>
                <input
                  type={showSecrets ? 'text' : 'password'}
                  value={encryptKey}
                  onChange={(e) => setEncryptKey(e.target.value)}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-100 text-sm focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="block text-sm text-zinc-400 mb-1">Verification Token (可选)</label>
                <input
                  type={showSecrets ? 'text' : 'password'}
                  value={verificationToken}
                  onChange={(e) => setVerificationToken(e.target.value)}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-100 text-sm focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="block text-sm text-zinc-400 mb-1">Webhook 端口</label>
                <input
                  type="number"
                  value={webhookPort}
                  onChange={(e) => setWebhookPort(e.target.value)}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-100 text-sm focus:outline-none focus:border-indigo-500"
                  placeholder="3200"
                  min={1}
                  max={65535}
                />
              </div>
              <div className="p-3 bg-zinc-800/50 rounded-lg border border-zinc-700">
                <p className="text-xs text-zinc-400">
                  <strong className="text-zinc-300">配置提示：</strong>
                </p>
                <ol className="text-xs text-zinc-500 mt-1 space-y-1 list-decimal list-inside">
                  <li>连接后本地 Webhook 地址：<code className="text-indigo-400">http://localhost:{webhookPort}/webhook/feishu</code></li>
                  <li>使用 ngrok 暴露公网：<code className="text-indigo-400">ngrok http {webhookPort}</code></li>
                  <li>将 ngrok URL 填入飞书开放平台「事件与回调」→「请求地址配置」</li>
                </ol>
              </div>
            </>
          )}

          {/* 按钮 */}
          <div className="flex justify-end gap-3 pt-4">
            <Button type="button" variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" variant="primary">
              {account ? '保存' : '添加'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
};

// ============================================================================
// Main Component
// ============================================================================

export const ChannelsSettings: React.FC = () => {
  const { t } = useI18n();
  const [accounts, setAccounts] = useState<ChannelAccount[]>([]);
  const [channelTypes, setChannelTypes] = useState<ChannelTypeInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [editingAccount, setEditingAccount] = useState<ChannelAccount | undefined>();
  const [connectingId, setConnectingId] = useState<string | null>(null);

  const loadData = async () => {
    try {
      const [accountsResult, typesResult] = await Promise.all([
        window.electronAPI?.invoke(IPC_CHANNELS.CHANNEL_LIST_ACCOUNTS),
        window.electronAPI?.invoke(IPC_CHANNELS.CHANNEL_GET_TYPES),
      ]);
      setAccounts(accountsResult || []);
      setChannelTypes(typesResult || []);
    } catch (error) {
      logger.error('Failed to load channel data', error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadData();

    // 监听账号变化
    const removeAccountsListener = window.electronAPI?.on(
      IPC_CHANNELS.CHANNEL_ACCOUNTS_CHANGED,
      (newAccounts: ChannelAccount[]) => {
        setAccounts(newAccounts);
      }
    );

    // 监听状态变化
    const removeStatusListener = window.electronAPI?.on(
      IPC_CHANNELS.CHANNEL_ACCOUNT_STATUS_CHANGED,
      ({ accountId, status, error }) => {
        setAccounts((prev) =>
          prev.map((a) =>
            a.id === accountId ? { ...a, status: status as ChannelAccount['status'], errorMessage: error } : a
          )
        );
        setConnectingId(null);
      }
    );

    return () => {
      removeAccountsListener?.();
      removeStatusListener?.();
    };
  }, []);

  const handleAdd = () => {
    setEditingAccount(undefined);
    setShowModal(true);
  };

  const handleEdit = (account: ChannelAccount) => {
    setEditingAccount(account);
    setShowModal(true);
  };

  const handleSave = async (data: { name: string; type: ChannelType; config: ChannelAccountConfig }) => {
    try {
      if (editingAccount) {
        await window.electronAPI?.invoke(IPC_CHANNELS.CHANNEL_UPDATE_ACCOUNT, {
          id: editingAccount.id,
          name: data.name,
          config: data.config,
        });
        setMessage({ type: 'success', text: '通道已更新' });
      } else {
        await window.electronAPI?.invoke(IPC_CHANNELS.CHANNEL_ADD_ACCOUNT, data);
        setMessage({ type: 'success', text: '通道已添加' });
      }
      setShowModal(false);
      await loadData();
    } catch (error) {
      setMessage({ type: 'error', text: '操作失败' });
    }
  };

  const handleDelete = async (accountId: string) => {
    if (!confirm('确定要删除这个通道吗？')) return;

    try {
      await window.electronAPI?.invoke(IPC_CHANNELS.CHANNEL_DELETE_ACCOUNT, accountId);
      setMessage({ type: 'success', text: '通道已删除' });
      await loadData();
    } catch (error) {
      setMessage({ type: 'error', text: '删除失败' });
    }
  };

  const handleToggleConnection = async (account: ChannelAccount) => {
    setConnectingId(account.id);
    try {
      if (account.status === 'connected') {
        await window.electronAPI?.invoke(IPC_CHANNELS.CHANNEL_DISCONNECT_ACCOUNT, account.id);
      } else {
        await window.electronAPI?.invoke(IPC_CHANNELS.CHANNEL_CONNECT_ACCOUNT, account.id);
      }
    } catch (error) {
      setMessage({ type: 'error', text: '操作失败' });
      setConnectingId(null);
    }
  };

  const getStatusColor = (status: ChannelAccount['status']): string => {
    switch (status) {
      case 'connected':
        return 'text-green-400';
      case 'connecting':
        return 'text-yellow-400';
      case 'error':
        return 'text-red-400';
      default:
        return 'text-zinc-400';
    }
  };

  const getStatusText = (status: ChannelAccount['status']): string => {
    switch (status) {
      case 'connected':
        return '已连接';
      case 'connecting':
        return '连接中';
      case 'error':
        return '错误';
      default:
        return '未连接';
    }
  };

  const getTypeIcon = (type: ChannelType) => {
    switch (type) {
      case 'http-api':
        return <Globe className="w-4 h-4 text-indigo-400" />;
      case 'feishu':
        return <MessageSquare className="w-4 h-4 text-blue-400" />;
      default:
        return <MessageSquare className="w-4 h-4 text-zinc-400" />;
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-zinc-400" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h3 className="text-sm font-medium text-zinc-100 mb-2">多通道接入</h3>
        <p className="text-xs text-zinc-400 mb-4">
          配置外部通道以通过 HTTP API、飞书等方式与 Agent 交互。
        </p>
      </div>

      {/* Add Button */}
      <Button
        onClick={handleAdd}
        variant="primary"
        leftIcon={<Plus className="w-4 h-4" />}
      >
        添加通道
      </Button>

      {/* Account List */}
      <div className="space-y-3">
        {accounts.length === 0 ? (
          <div className="bg-zinc-800/50 rounded-lg p-4 text-center text-zinc-400 text-sm">
            还没有配置任何通道
          </div>
        ) : (
          accounts.map((account) => (
            <div
              key={account.id}
              className="bg-zinc-800/50 rounded-lg p-4"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {getTypeIcon(account.type)}
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-zinc-100">{account.name}</span>
                      <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-700 text-zinc-400">
                        {channelTypes.find(t => t.type === account.type)?.name || account.type}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-xs">
                      <span className={getStatusColor(account.status)}>
                        {getStatusText(account.status)}
                      </span>
                      {account.type === 'http-api' && (
                        <>
                          <span className="text-zinc-400">
                            端口: {(account.config as HttpApiChannelConfig).port}
                          </span>
                          <span className="text-zinc-500 font-mono">
                            Key: {(account.config as HttpApiChannelConfig).apiKey?.substring(0, 8)}...
                          </span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              const key = (account.config as HttpApiChannelConfig).apiKey;
                              if (key) {
                                navigator.clipboard.writeText(key);
                                setMessage({ type: 'success', text: 'API Key 已复制到剪贴板' });
                              }
                            }}
                            className="text-indigo-400 hover:text-indigo-300 transition-colors"
                            title="复制 API Key"
                          >
                            复制Key
                          </button>
                        </>
                      )}
                      {account.errorMessage && (
                        <span className="text-red-400 truncate max-w-[200px]" title={account.errorMessage}>
                          {account.errorMessage}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => handleToggleConnection(account)}
                    loading={connectingId === account.id}
                    leftIcon={
                      account.status === 'connected' ? (
                        <PowerOff className="w-3 h-3" />
                      ) : (
                        <Power className="w-3 h-3" />
                      )
                    }
                  >
                    {account.status === 'connected' ? '断开' : '连接'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => handleEdit(account)}
                    leftIcon={<Edit className="w-3 h-3" />}
                  >
                    编辑
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => handleDelete(account.id)}
                    leftIcon={<Trash2 className="w-3 h-3 text-red-400" />}
                  >
                    删除
                  </Button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Message */}
      {message && (
        <div
          className={`flex items-center gap-2 p-3 rounded-lg ${
            message.type === 'success' ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'
          }`}
        >
          {message.type === 'success' ? (
            <CheckCircle className="w-4 h-4" />
          ) : (
            <AlertCircle className="w-4 h-4" />
          )}
          <span className="text-sm">{message.text}</span>
        </div>
      )}

      {/* Info Box */}
      <div className="bg-zinc-800/50 rounded-lg p-4">
        <h4 className="text-sm font-medium text-zinc-100 mb-2">使用说明</h4>
        <div className="text-xs text-zinc-400 leading-relaxed space-y-2">
          <p>
            <strong>HTTP API:</strong> 创建本地 REST API 端点，支持同步和流式响应。
            使用 X-API-Key 头进行认证。
          </p>
          <p>
            <strong>飞书:</strong> 连接飞书机器人，支持私聊和群聊消息。
            需要在飞书开放平台创建应用并获取凭证。
          </p>
        </div>
      </div>

      {/* Modal */}
      {showModal && (
        <ChannelModal
          account={editingAccount}
          channelTypes={channelTypes}
          onSave={handleSave}
          onClose={() => setShowModal(false)}
        />
      )}
    </div>
  );
};
