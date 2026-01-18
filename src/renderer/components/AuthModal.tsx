// ============================================================================
// Auth Modal - Login/Register dialog
// ============================================================================

import React, { useState } from 'react';
import { useAuthStore } from '../stores/authStore';
import { X, Loader2, UserPlus, LogIn } from 'lucide-react';

type AuthMode = 'signin' | 'signup';

export const AuthModal: React.FC = () => {
  const {
    signInWithEmail,
    signUpWithEmail,
    isLoading,
    error,
    showAuthModal,
    setShowAuthModal,
  } = useAuthStore();

  const [mode, setMode] = useState<AuthMode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');

  if (!showAuthModal) return null;

  const onClose = () => setShowAuthModal(false);

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    let success: boolean;

    if (mode === 'signin') {
      success = await signInWithEmail(email, password);
    } else {
      success = await signUpWithEmail(email, password, inviteCode || undefined);
    }

    if (success) {
      setEmail('');
      setPassword('');
      setInviteCode('');
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative w-full max-w-md bg-zinc-900 rounded-xl border border-zinc-800 shadow-2xl p-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold text-zinc-100">
            {mode === 'signin' ? '登录' : '注册'}
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-zinc-800 text-zinc-400 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Error message */}
        {error && (
          <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
            {error}
          </div>
        )}

        {/* Mode tabs */}
        <div className="flex mb-6 border-b border-zinc-800">
          <button
            onClick={() => setMode('signin')}
            className={`flex-1 pb-2 text-sm transition-colors ${
              mode === 'signin'
                ? 'text-blue-400 border-b-2 border-blue-400'
                : 'text-zinc-400 hover:text-zinc-300'
            }`}
          >
            <LogIn className="w-4 h-4 inline mr-1" />
            登录
          </button>
          <button
            onClick={() => setMode('signup')}
            className={`flex-1 pb-2 text-sm transition-colors ${
              mode === 'signup'
                ? 'text-blue-400 border-b-2 border-blue-400'
                : 'text-zinc-400 hover:text-zinc-300'
            }`}
          >
            <UserPlus className="w-4 h-4 inline mr-1" />
            注册
          </button>
        </div>

        {/* Email/Password form */}
        <form onSubmit={handleEmailSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-zinc-400 mb-1">邮箱</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="your@email.com"
              className="w-full px-4 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500"
              required
            />
          </div>
          <div>
            <label className="block text-sm text-zinc-400 mb-1">密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="至少6位"
              className="w-full px-4 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500"
              required
              minLength={6}
            />
          </div>

          {mode === 'signup' && (
            <div>
              <label className="block text-sm text-zinc-400 mb-1">
                邀请码 <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
                placeholder="输入邀请码"
                className="w-full px-4 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500"
                required
              />
              <p className="mt-1 text-xs text-zinc-500">
                需要邀请码才能注册，请联系管理员获取
              </p>
            </div>
          )}

          <button
            type="submit"
            disabled={isLoading}
            className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-white font-medium flex items-center justify-center gap-2 transition-colors min-h-[42px]"
          >
            {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
            {mode === 'signin' ? '登录' : '注册'}
            {isLoading && '中...'}
          </button>
        </form>

      </div>
    </div>
  );
};
