// ============================================================================
// User Menu - User dropdown with account and sync options
// ============================================================================

import React, { useState, useRef, useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';
import {
  User,
  LogOut,
  Copy,
  Check,
  Cloud,
  CloudOff,
  RefreshCw,
  Monitor,
} from 'lucide-react';

export const UserMenu: React.FC = () => {
  const {
    user,
    isAuthenticated,
    signOut,
    generateQuickToken,
    syncStatus,
    startSync,
    stopSync,
    forceFullSync,
  } = useAuthStore();

  const [showMenu, setShowMenu] = useState(false);
  const [quickToken, setQuickToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowMenu(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleGenerateToken = async () => {
    const token = await generateQuickToken();
    setQuickToken(token);
  };

  const handleCopyToken = async () => {
    if (quickToken) {
      await navigator.clipboard.writeText(quickToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleForceSync = async () => {
    setSyncing(true);
    await forceFullSync();
    setSyncing(false);
  };

  if (!isAuthenticated || !user) {
    return null;
  }

  return (
    <div className="relative" ref={menuRef}>
      {/* User button */}
      <button
        onClick={() => setShowMenu(!showMenu)}
        className="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-zinc-800 transition-colors"
      >
        {user.avatarUrl ? (
          <img
            src={user.avatarUrl}
            alt=""
            className="w-6 h-6 rounded-full object-cover"
          />
        ) : (
          <div className="w-6 h-6 rounded-full bg-blue-600 flex items-center justify-center">
            <User className="w-4 h-4 text-white" />
          </div>
        )}
        <span className="text-sm text-zinc-300 max-w-24 truncate">
          {user.nickname || user.email?.split('@')[0]}
        </span>
      </button>

      {/* Dropdown menu */}
      {showMenu && (
        <div className="absolute right-0 top-full mt-2 w-72 bg-zinc-900 border border-zinc-800 rounded-lg shadow-xl z-50">
          {/* User info */}
          <div className="p-3 border-b border-zinc-800">
            <div className="flex items-center gap-3">
              {user.avatarUrl ? (
                <img
                  src={user.avatarUrl}
                  alt=""
                  className="w-10 h-10 rounded-full object-cover"
                />
              ) : (
                <div className="w-10 h-10 rounded-full bg-blue-600 flex items-center justify-center">
                  <User className="w-6 h-6 text-white" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-zinc-100 truncate">
                  {user.nickname || user.username || '用户'}
                </div>
                <div className="text-xs text-zinc-500 truncate">
                  {user.email}
                </div>
              </div>
            </div>
          </div>

          {/* Sync status */}
          <div className="p-3 border-b border-zinc-800">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-zinc-400">云端同步</span>
              <button
                onClick={() =>
                  syncStatus.isEnabled ? stopSync() : startSync()
                }
                className={`flex items-center gap-1 text-xs px-2 py-1 rounded ${
                  syncStatus.isEnabled
                    ? 'text-green-400 bg-green-400/10'
                    : 'text-zinc-500 bg-zinc-800'
                }`}
              >
                {syncStatus.isEnabled ? (
                  <>
                    <Cloud className="w-3 h-3" />
                    已开启
                  </>
                ) : (
                  <>
                    <CloudOff className="w-3 h-3" />
                    已关闭
                  </>
                )}
              </button>
            </div>

            {syncStatus.lastSyncAt && (
              <div className="text-xs text-zinc-500 mb-2">
                上次同步:{' '}
                {new Date(syncStatus.lastSyncAt).toLocaleString('zh-CN', {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </div>
            )}

            {syncStatus.isEnabled && (
              <button
                onClick={handleForceSync}
                disabled={syncing || syncStatus.isSyncing}
                className="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-50"
              >
                <RefreshCw
                  className={`w-3 h-3 ${syncing || syncStatus.isSyncing ? 'animate-spin' : ''}`}
                />
                {syncing || syncStatus.isSyncing ? '同步中...' : '立即同步'}
              </button>
            )}

            {syncStatus.error && (
              <div className="text-xs text-red-400 mt-1">{syncStatus.error}</div>
            )}
          </div>

          {/* Quick login token */}
          <div className="p-3 border-b border-zinc-800">
            <div className="text-xs text-zinc-400 mb-2">快捷登录 Token</div>
            {quickToken ? (
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs bg-zinc-800 px-2 py-1.5 rounded font-mono truncate">
                  {quickToken}
                </code>
                <button
                  onClick={handleCopyToken}
                  className="p-1.5 text-zinc-400 hover:text-zinc-100 bg-zinc-800 rounded transition-colors"
                >
                  {copied ? (
                    <Check className="w-4 h-4 text-green-400" />
                  ) : (
                    <Copy className="w-4 h-4" />
                  )}
                </button>
              </div>
            ) : (
              <button
                onClick={handleGenerateToken}
                className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
              >
                生成快捷登录 Token
              </button>
            )}
            <p className="text-xs text-zinc-500 mt-1">
              用于在其他设备快速登录
            </p>
          </div>

          {/* Actions */}
          <div className="p-2">
            <button
              onClick={() => {
                signOut();
                setShowMenu(false);
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded-lg transition-colors"
            >
              <LogOut className="w-4 h-4" />
              退出登录
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
