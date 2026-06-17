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
  Search,
  Eye,
  EyeOff,
} from 'lucide-react';
import { Button, Modal } from '../../../primitives';
import { SettingsDetails, SettingsPage, SettingsSection } from '../SettingsLayout';
import { createLogger } from '../../../../utils/logger';
import { IPC_CHANNELS } from '@shared/ipc';
import type {
  ChannelAccount,
  ChannelType,
  ChannelAccountConfig,
  ChannelPrivacyMode,
  HttpApiChannelConfig,
  FeishuChannelConfig,
  LarkChannelConfig,
  TelegramChannelConfig,
} from '@shared/contract/channel';
import { isWebMode } from '../../../../utils/platform';
import { WebModeBanner } from '../WebModeBanner';
import ipcService from '../../../../services/ipcService';

const logger = createLogger('ChannelsSettings');

// ============================================================================
// Types
// ============================================================================

export interface ChannelTypeInfo {
  type: ChannelType;
  name: string;
  description?: string;
}

export type ChannelStatusFilter = 'all' | ChannelAccount['status'];

const CHANNEL_STATUS_FILTERS: Array<{ value: ChannelStatusFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'connected', label: '已连接' },
  { value: 'connecting', label: '连接中' },
  { value: 'error', label: '异常' },
  { value: 'disconnected', label: '未连接' },
];

export const CHANNEL_PRIVACY_MODE_OPTIONS: Array<{
  value: ChannelPrivacyMode;
  label: string;
  description: string;
}> = [
  {
    value: 'local-redact',
    label: '默认脱敏',
    description: '入站消息、附件摘要和 raw payload 在本地落地或分发前脱敏。',
  },
  {
    value: 'allow-raw',
    label: '保留 raw 调试',
    description: '业务文本仍走脱敏，但保留原始 raw payload，适合受控连接器排障。',
  },
  {
    value: 'off',
    label: '关闭通道脱敏',
    description: '仅用于受控本地调试；消息、附件和 raw payload 可能保留原文。',
  },
];

export function getChannelPrivacyModeCopy(mode: ChannelPrivacyMode): { label: string; description: string } {
  return CHANNEL_PRIVACY_MODE_OPTIONS.find((option) => option.value === mode)
    ?? CHANNEL_PRIVACY_MODE_OPTIONS[0];
}

export function getChannelTypeLabel(
  type: ChannelType,
  channelTypes: ChannelTypeInfo[],
): string {
  return channelTypes.find((channelType) => channelType.type === type)?.name || type;
}

export function getChannelConfigSummary(account: ChannelAccount): string {
  if (account.type === 'http-api') {
    const config = account.config as HttpApiChannelConfig;
    return `端口 ${config.port}`;
  }

  if (account.type === 'feishu') {
    const config = account.config as FeishuChannelConfig;
    return `Webhook ${config.webhookPort || 3200}`;
  }

  if (account.type === 'lark') {
    const config = account.config as LarkChannelConfig;
    return `Webhook ${config.webhookPort || 3200}`;
  }

  if (account.type === 'telegram') {
    const config = account.config as TelegramChannelConfig;
    return config.allowedUserIds?.length
      ? `${config.allowedUserIds.length} 个白名单用户`
      : 'Long Polling';
  }

  return '已配置';
}

export function getChannelStatusSummary(accounts: ChannelAccount[]) {
  return {
    total: accounts.length,
    connected: accounts.filter((account) => account.status === 'connected').length,
    connecting: accounts.filter((account) => account.status === 'connecting').length,
    error: accounts.filter((account) => account.status === 'error').length,
    disconnected: accounts.filter((account) => account.status === 'disconnected').length,
  };
}

export function filterChannelAccounts({
  accounts,
  channelTypes,
  statusFilter,
  query,
}: {
  accounts: ChannelAccount[];
  channelTypes: ChannelTypeInfo[];
  statusFilter: ChannelStatusFilter;
  query: string;
}): ChannelAccount[] {
  const normalizedQuery = query.trim().toLowerCase();

  return accounts.filter((account) => {
    const matchesStatus = statusFilter === 'all' || account.status === statusFilter;
    const matchesQuery =
      !normalizedQuery ||
      account.name.toLowerCase().includes(normalizedQuery) ||
      account.type.toLowerCase().includes(normalizedQuery) ||
      getChannelTypeLabel(account.type, channelTypes).toLowerCase().includes(normalizedQuery) ||
      account.status.toLowerCase().includes(normalizedQuery);

    return matchesStatus && matchesQuery;
  });
}

const ChannelFilterButton: React.FC<{
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}> = ({ active, children, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className={`h-7 rounded-md px-2.5 text-xs transition-colors ${
      active
        ? 'bg-zinc-200 text-zinc-950'
        : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
    }`}
  >
    {children}
  </button>
);

const ChannelSummaryTile: React.FC<{
  label: string;
  value: number;
  tone?: 'default' | 'success' | 'warning' | 'danger';
}> = ({ label, value, tone = 'default' }) => {
  const toneClass =
    tone === 'success'
      ? 'text-emerald-300'
      : tone === 'warning'
        ? 'text-amber-300'
        : tone === 'danger'
          ? 'text-red-300'
          : 'text-zinc-200';

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2">
      <div className={`text-lg font-semibold ${toneClass}`}>{value}</div>
      <div className="mt-0.5 text-xs text-zinc-500">{label}</div>
    </div>
  );
};

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

export const ChannelModal: React.FC<ChannelModalProps> = ({
  account,
  channelTypes,
  onSave,
  onClose,
}) => {
  const [name, setName] = useState(account?.name || '');
  const [type, setType] = useState<ChannelType>(account?.type || 'http-api');
  const [showSecrets, setShowSecrets] = useState(false);
  const [privacyMode, setPrivacyMode] = useState<ChannelPrivacyMode>(
    account?.config.privacyMode || 'local-redact'
  );

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
  const larkLikeConfig = account?.config as FeishuChannelConfig | LarkChannelConfig | undefined;
  const [appId, setAppId] = useState(larkLikeConfig?.appId || '');
  const [appSecret, setAppSecret] = useState(larkLikeConfig?.appSecret || '');
  const [encryptKey, setEncryptKey] = useState(larkLikeConfig?.encryptKey || '');
  const [verificationToken, setVerificationToken] = useState(larkLikeConfig?.verificationToken || '');
  const [webhookPort, setWebhookPort] = useState(larkLikeConfig?.webhookPort?.toString() || '3200');

  // Telegram 配置
  const [botToken, setBotToken] = useState(
    (account?.config as TelegramChannelConfig)?.botToken || ''
  );
  const [tgProxyUrl, setTgProxyUrl] = useState(
    (account?.config as TelegramChannelConfig)?.proxyUrl || ''
  );
  const [tgFallbackProxy, setTgFallbackProxy] = useState(
    (account?.config as TelegramChannelConfig)?.fallbackProxyUrl || ''
  );
  const [tgAllowedUserIds, setTgAllowedUserIds] = useState(
    (account?.config as TelegramChannelConfig)?.allowedUserIds?.join(', ') || ''
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
        privacyMode,
      };
    } else if (type === 'feishu' || type === 'lark') {
      config = {
        type,
        appId,
        appSecret,
        encryptKey: encryptKey || undefined,
        verificationToken: verificationToken || undefined,
        useWebSocket: false, // 默认使用 Webhook 模式
        webhookPort: parseInt(webhookPort) || 3200,
        privacyMode,
      };
    } else if (type === 'telegram') {
      const userIds = tgAllowedUserIds
        .split(',')
        .map(s => parseInt(s.trim()))
        .filter(n => !isNaN(n));
      config = {
        type: 'telegram',
        botToken,
        proxyUrl: tgProxyUrl || undefined,
        fallbackProxyUrl: tgFallbackProxy || undefined,
        allowedUserIds: userIds.length > 0 ? userIds : undefined,
        privacyMode,
      };
    } else {
      console.warn('Unknown channel type:', type);
      return;
    }

    onSave({ name, type, config });
  };

  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title={account ? '编辑通道' : '添加通道'}
      size="md"
    >
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* 名称 */}
          <div>
            <label className="block text-sm text-zinc-400 mb-1">名称</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 bg-zinc-700 border border-zinc-700 rounded-lg text-zinc-200 text-sm focus:outline-hidden focus:border-indigo-500"
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
                className="w-full px-3 py-2 bg-zinc-700 border border-zinc-700 rounded-lg text-zinc-200 text-sm focus:outline-hidden focus:border-indigo-500"
              >
                {channelTypes.map((ct) => (
                  <option key={ct.type} value={ct.type}>
                    {ct.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="block text-sm text-zinc-400 mb-1">隐私策略</label>
            <select
              value={privacyMode}
              onChange={(e) => setPrivacyMode(e.target.value as ChannelPrivacyMode)}
              className="w-full px-3 py-2 bg-zinc-700 border border-zinc-700 rounded-lg text-zinc-200 text-sm focus:outline-hidden focus:border-indigo-500"
            >
              {CHANNEL_PRIVACY_MODE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-zinc-500">
              {getChannelPrivacyModeCopy(privacyMode).description}
            </p>
          </div>

          {/* HTTP API 配置 */}
          {type === 'http-api' && (
            <>
              <div>
                <label className="block text-sm text-zinc-400 mb-1">端口</label>
                <input
                  type="number"
                  value={apiPort}
                  onChange={(e) => setApiPort(e.target.value)}
                  className="w-full px-3 py-2 bg-zinc-700 border border-zinc-700 rounded-lg text-zinc-200 text-sm focus:outline-hidden focus:border-indigo-500"
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
                    className="ml-2 text-zinc-500 hover:text-zinc-400"
                  >
                    {showSecrets ? <EyeOff className="w-3 h-3 inline" /> : <Eye className="w-3 h-3 inline" />}
                  </button>
                </label>
                <input
                  type={showSecrets ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="w-full px-3 py-2 bg-zinc-700 border border-zinc-700 rounded-lg text-zinc-200 text-sm focus:outline-hidden focus:border-indigo-500"
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

          {/* 飞书 / Lark 配置 */}
          {(type === 'feishu' || type === 'lark') && (
            <>
              <div>
                <label className="block text-sm text-zinc-400 mb-1">App ID</label>
                <input
                  type="text"
                  value={appId}
                  onChange={(e) => setAppId(e.target.value)}
                  className="w-full px-3 py-2 bg-zinc-700 border border-zinc-700 rounded-lg text-zinc-200 text-sm focus:outline-hidden focus:border-indigo-500"
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
                    className="ml-2 text-zinc-500 hover:text-zinc-400"
                  >
                    {showSecrets ? <EyeOff className="w-3 h-3 inline" /> : <Eye className="w-3 h-3 inline" />}
                  </button>
                </label>
                <input
                  type={showSecrets ? 'text' : 'password'}
                  value={appSecret}
                  onChange={(e) => setAppSecret(e.target.value)}
                  className="w-full px-3 py-2 bg-zinc-700 border border-zinc-700 rounded-lg text-zinc-200 text-sm focus:outline-hidden focus:border-indigo-500"
                  required
                />
              </div>
              <div>
                <label className="block text-sm text-zinc-400 mb-1">Encrypt Key (可选)</label>
                <input
                  type={showSecrets ? 'text' : 'password'}
                  value={encryptKey}
                  onChange={(e) => setEncryptKey(e.target.value)}
                  className="w-full px-3 py-2 bg-zinc-700 border border-zinc-700 rounded-lg text-zinc-200 text-sm focus:outline-hidden focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="block text-sm text-zinc-400 mb-1">Verification Token (可选)</label>
                <input
                  type={showSecrets ? 'text' : 'password'}
                  value={verificationToken}
                  onChange={(e) => setVerificationToken(e.target.value)}
                  className="w-full px-3 py-2 bg-zinc-700 border border-zinc-700 rounded-lg text-zinc-200 text-sm focus:outline-hidden focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="block text-sm text-zinc-400 mb-1">Webhook 端口</label>
                <input
                  type="number"
                  value={webhookPort}
                  onChange={(e) => setWebhookPort(e.target.value)}
                  className="w-full px-3 py-2 bg-zinc-700 border border-zinc-700 rounded-lg text-zinc-200 text-sm focus:outline-hidden focus:border-indigo-500"
                  placeholder="3200"
                  min={1}
                  max={65535}
                />
              </div>
              <div className="p-3 bg-zinc-800 rounded-lg border border-zinc-700">
                <p className="text-xs text-zinc-400">
                  <strong className="text-zinc-400">配置提示：</strong>
                </p>
                <ol className="text-xs text-zinc-500 mt-1 space-y-1 list-decimal list-inside">
                  <li>连接后本地 Webhook 地址：<code className="text-indigo-400">http://localhost:{webhookPort}/webhook/feishu</code></li>
                  <li>使用 ngrok 暴露公网：<code className="text-indigo-400">ngrok http {webhookPort}</code></li>
                  <li>将 ngrok URL 填入{type === 'lark' ? ' Lark Developer Console' : '飞书开放平台'}「事件与回调」请求地址配置</li>
                </ol>
              </div>
            </>
          )}

          {/* Telegram 配置 */}
          {type === 'telegram' && (
            <>
              <div>
                <label className="block text-sm text-zinc-400 mb-1">
                  Bot Token
                  <button
                    type="button"
                    onClick={() => setShowSecrets(!showSecrets)}
                    className="ml-2 text-zinc-500 hover:text-zinc-400"
                  >
                    {showSecrets ? <EyeOff className="w-3 h-3 inline" /> : <Eye className="w-3 h-3 inline" />}
                  </button>
                </label>
                <input
                  type={showSecrets ? 'text' : 'password'}
                  value={botToken}
                  onChange={(e) => setBotToken(e.target.value)}
                  className="w-full px-3 py-2 bg-zinc-700 border border-zinc-700 rounded-lg text-zinc-200 text-sm focus:outline-hidden focus:border-indigo-500"
                  placeholder="从 @BotFather 获取"
                  required
                />
              </div>
              <div>
                <label className="block text-sm text-zinc-400 mb-1">代理 URL (可选)</label>
                <input
                  type="text"
                  value={tgProxyUrl}
                  onChange={(e) => setTgProxyUrl(e.target.value)}
                  className="w-full px-3 py-2 bg-zinc-700 border border-zinc-700 rounded-lg text-zinc-200 text-sm focus:outline-hidden focus:border-indigo-500"
                  placeholder="http://127.0.0.1:7897 (默认读 HTTPS_PROXY)"
                />
              </div>
              <div>
                <label className="block text-sm text-zinc-400 mb-1">备用代理 URL (可选)</label>
                <input
                  type="text"
                  value={tgFallbackProxy}
                  onChange={(e) => setTgFallbackProxy(e.target.value)}
                  className="w-full px-3 py-2 bg-zinc-700 border border-zinc-700 rounded-lg text-zinc-200 text-sm focus:outline-hidden focus:border-indigo-500"
                  placeholder="主代理不可用时自动切换"
                />
              </div>
              <div>
                <label className="block text-sm text-zinc-400 mb-1">白名单用户 ID (可选)</label>
                <input
                  type="text"
                  value={tgAllowedUserIds}
                  onChange={(e) => setTgAllowedUserIds(e.target.value)}
                  className="w-full px-3 py-2 bg-zinc-700 border border-zinc-700 rounded-lg text-zinc-200 text-sm focus:outline-hidden focus:border-indigo-500"
                  placeholder="逗号分隔，留空允许所有用户"
                />
              </div>
              <div className="p-3 bg-zinc-800 rounded-lg border border-zinc-700">
                <p className="text-xs text-zinc-400">
                  <strong className="text-zinc-400">配置提示：</strong>
                </p>
                <ol className="text-xs text-zinc-500 mt-1 space-y-1 list-decimal list-inside">
                  <li>在 Telegram 中搜索 <code className="text-indigo-400">@BotFather</code> 创建 Bot</li>
                  <li>发送 <code className="text-indigo-400">/newbot</code> 并按提示操作获取 Token</li>
                  <li>国内环境需配置代理才能连接 Telegram API</li>
                  <li>使用 Long Polling 模式，无需公网 IP</li>
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
    </Modal>
  );
};

// ============================================================================
// Main Component
// ============================================================================

export const ChannelsSettings: React.FC = () => {
  const [accounts, setAccounts] = useState<ChannelAccount[]>([]);
  const [channelTypes, setChannelTypes] = useState<ChannelTypeInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [editingAccount, setEditingAccount] = useState<ChannelAccount | undefined>();
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<ChannelStatusFilter>('all');
  const [query, setQuery] = useState('');

  // 自动清除成功消息
  useEffect(() => {
    if (message?.type === 'success') {
      const timer = setTimeout(() => setMessage(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  const loadData = async () => {
    try {
      const [accountsResult, typesResult] = await Promise.all([
        ipcService.invoke(IPC_CHANNELS.CHANNEL_LIST_ACCOUNTS),
        ipcService.invoke(IPC_CHANNELS.CHANNEL_GET_TYPES),
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
    const removeAccountsListener = ipcService.on(
      IPC_CHANNELS.CHANNEL_ACCOUNTS_CHANGED,
      (newAccounts: ChannelAccount[]) => {
        setAccounts(newAccounts);
      }
    );

    // 监听状态变化
    const removeStatusListener = ipcService.on(
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
        await ipcService.invoke(IPC_CHANNELS.CHANNEL_UPDATE_ACCOUNT, {
          id: editingAccount.id,
          name: data.name,
          config: data.config,
        });
        setMessage({ type: 'success', text: '通道已更新' });
      } else {
        await ipcService.invoke(IPC_CHANNELS.CHANNEL_ADD_ACCOUNT, data);
        setMessage({ type: 'success', text: '通道已添加' });
      }
      setShowModal(false);
      await loadData();
    } catch {
      setMessage({ type: 'error', text: '操作失败' });
    }
  };

  const handleDelete = async (accountId: string) => {
    if (!confirm('确定要删除这个通道吗？')) return;

    try {
      await ipcService.invoke(IPC_CHANNELS.CHANNEL_DELETE_ACCOUNT, accountId);
      setMessage({ type: 'success', text: '通道已删除' });
      await loadData();
    } catch {
      setMessage({ type: 'error', text: '删除失败' });
    }
  };

  const handleToggleConnection = async (account: ChannelAccount) => {
    setConnectingId(account.id);
    try {
      if (account.status === 'connected') {
        await ipcService.invoke(IPC_CHANNELS.CHANNEL_DISCONNECT_ACCOUNT, account.id);
      } else {
        await ipcService.invoke(IPC_CHANNELS.CHANNEL_CONNECT_ACCOUNT, account.id);
      }
    } catch {
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
      case 'lark':
        return <MessageSquare className="w-4 h-4 text-emerald-400" />;
      case 'telegram':
        return <MessageSquare className="w-4 h-4 text-sky-400" />;
      default:
        return <MessageSquare className="w-4 h-4 text-zinc-400" />;
    }
  };

  const statusSummary = getChannelStatusSummary(accounts);
  const filteredAccounts = filterChannelAccounts({
    accounts,
    channelTypes,
    statusFilter,
    query,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-zinc-400" />
      </div>
    );
  }

  return (
    <SettingsPage
      title="通道"
      description="配置外部入口，让 HTTP API、飞书、Lark 或 Telegram 可以和 Agent 交互。连接说明默认收起。"
    >
      <WebModeBanner />

      <SettingsSection
        title="低打扰策略"
        description="通道会话默认不触发桌面 reply notification；处理过程留在通道 typing / streaming / 任务面板里，系统通知只用于需要介入或任务完成。"
      >
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/45 p-3 text-xs leading-relaxed text-zinc-400">
          飞书、Telegram、HTTP API 的普通回复不会弹桌面通知。错误回复只发短摘要，完整 trace 留在本机诊断；后续如需每个通道的完成提醒，也必须显式打开并继续走脱敏。
        </div>
      </SettingsSection>

      <SettingsSection
        title="通道账号"
        actions={(
          <Button
            size="sm"
            disabled={isWebMode()}
            onClick={handleAdd}
            variant="primary"
            leftIcon={<Plus className="w-3 h-3" />}
          >
            添加通道
          </Button>
        )}
      >
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <ChannelSummaryTile label="全部账号" value={statusSummary.total} />
            <ChannelSummaryTile label="已连接" value={statusSummary.connected} tone="success" />
            <ChannelSummaryTile label="连接中" value={statusSummary.connecting} tone="warning" />
            <ChannelSummaryTile label="异常" value={statusSummary.error} tone="danger" />
            <ChannelSummaryTile label="未连接" value={statusSummary.disconnected} />
          </div>

          <div className="flex flex-col gap-2 rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
            <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
              <div className="relative w-full lg:max-w-xs">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索账号、类型或状态"
                  className="h-8 w-full rounded-md border border-zinc-800 bg-zinc-950/70 pl-8 pr-3 text-sm text-zinc-200 outline-hidden transition-colors placeholder:text-zinc-600 focus:border-zinc-600"
                />
              </div>
              <div className="flex flex-wrap gap-1.5">
                {CHANNEL_STATUS_FILTERS.map((filter) => (
                  <ChannelFilterButton
                    key={filter.value}
                    active={statusFilter === filter.value}
                    onClick={() => setStatusFilter(filter.value)}
                  >
                    {filter.label}
                  </ChannelFilterButton>
                ))}
              </div>
            </div>

            <div className="text-xs text-zinc-500">
              当前显示 {filteredAccounts.length} / {accounts.length} 个账号
            </div>
          </div>

          {accounts.length === 0 ? (
            <div className="rounded-lg border border-dashed border-zinc-700 bg-zinc-900/60 p-8 text-center">
              <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-800 text-zinc-400">
                <MessageSquare className="h-5 w-5" />
              </div>
              <div className="mt-3 text-sm font-medium text-zinc-200">还没有通道账号</div>
              <div className="mt-1 text-xs text-zinc-500">
                添加 HTTP API、飞书、Lark 或 Telegram 账号后，可以在这里统一查看连接状态和执行启停操作。
              </div>
              <Button
                className="mt-4"
                size="sm"
                disabled={isWebMode()}
                onClick={handleAdd}
                variant="primary"
                leftIcon={<Plus className="w-3 h-3" />}
              >
                添加通道
              </Button>
            </div>
          ) : filteredAccounts.length === 0 ? (
            <div className="rounded-lg bg-zinc-800 p-6 text-center text-sm text-zinc-400">
              没有匹配的通道账号
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-zinc-800">
              <div className="min-w-[760px]">
                <div className="grid grid-cols-[minmax(220px,1.5fr)_120px_150px_minmax(160px,1fr)_210px] items-center border-b border-zinc-800 bg-zinc-900/80 px-3 py-2 text-xs font-medium text-zinc-500">
                  <div>账号</div>
                  <div>类型</div>
                  <div>状态</div>
                  <div>配置</div>
                  <div className="text-right">操作</div>
                </div>

                {filteredAccounts.map((account) => (
                  <div
                    key={account.id}
                    className="grid grid-cols-[minmax(220px,1.5fr)_120px_150px_minmax(160px,1fr)_210px] items-center border-b border-zinc-800 bg-zinc-900/30 px-3 py-3 last:border-b-0 hover:bg-zinc-800/50"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      {getTypeIcon(account.type)}
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-zinc-200">{account.name}</div>
                        <div className="mt-1 truncate text-xs text-zinc-500">{account.id}</div>
                      </div>
                    </div>

                    <div>
                      <span className="inline-flex h-6 items-center rounded-md bg-zinc-800 px-2 text-xs text-zinc-300">
                        {getChannelTypeLabel(account.type, channelTypes)}
                      </span>
                    </div>

                    <div className="min-w-0">
                      <div className={`text-sm font-medium ${getStatusColor(account.status)}`}>
                        {getStatusText(account.status)}
                      </div>
                      {account.errorMessage && (
                        <div className="mt-1 truncate text-xs text-red-400" title={account.errorMessage}>
                          {account.errorMessage}
                        </div>
                      )}
                    </div>

                    <div className="min-w-0 text-xs text-zinc-400">
                      <div className="truncate">{getChannelConfigSummary(account)}</div>
                      {account.type === 'http-api' && (
                        <div className="mt-1 flex items-center gap-2">
                          <span className="truncate font-mono text-zinc-500">
                            Key {(account.config as HttpApiChannelConfig).apiKey?.substring(0, 8)}...
                          </span>
                          <button
                            onClick={(event) => {
                              event.stopPropagation();
                              const key = (account.config as HttpApiChannelConfig).apiKey;
                              if (key) {
                                navigator.clipboard.writeText(key);
                                setMessage({ type: 'success', text: 'API Key 已复制到剪贴板' });
                              }
                            }}
                            className="shrink-0 text-indigo-400 transition-colors hover:text-indigo-300"
                            title="复制 API Key"
                          >
                            复制
                          </button>
                        </div>
                      )}
                    </div>

                    <div className="flex items-center justify-end gap-1.5">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={isWebMode()}
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
                        disabled={isWebMode()}
                        onClick={() => handleEdit(account)}
                        leftIcon={<Edit className="w-3 h-3" />}
                      >
                        编辑
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={isWebMode()}
                        onClick={() => handleDelete(account.id)}
                        leftIcon={<Trash2 className="w-3 h-3 text-red-400" />}
                      >
                        删除
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </SettingsSection>

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

      <SettingsDetails
        title="连接说明"
        description="各通道的认证、端口和代理要求。"
      >
        <div className="text-xs text-zinc-400 leading-relaxed space-y-2">
          <p>
            <strong>HTTP API:</strong> 创建本地 REST API 端点，支持同步和流式响应。
            使用 X-API-Key 头进行认证。
          </p>
          <p>
            <strong>飞书:</strong> 连接飞书机器人，支持私聊和群聊消息。
            需要在飞书开放平台创建应用并获取凭证。
          </p>
          <p>
            <strong>Lark:</strong> 连接 Lark International Bot，使用独立账号和来源标识。
            需要在 Lark Developer Console 创建应用并配置事件回调。
          </p>
          <p>
            <strong>Telegram:</strong> 连接 Telegram Bot，支持私聊和群组。
            通过 @BotFather 创建 Bot 获取 Token，使用 Long Polling 无需公网。
          </p>
        </div>
      </SettingsDetails>

      {/* Modal */}
      {showModal && (
        <ChannelModal
          account={editingAccount}
          channelTypes={channelTypes}
          onSave={handleSave}
          onClose={() => setShowModal(false)}
        />
      )}
    </SettingsPage>
  );
};
