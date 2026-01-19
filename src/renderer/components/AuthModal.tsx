// ============================================================================
// Auth Modal - Login/Register dialog
// ============================================================================

import React, { useState } from 'react';
import { useAuthStore } from '../stores/authStore';
import { Loader2, UserPlus, LogIn } from 'lucide-react';
import { FormField, Input } from './composites/FormField';
import { Modal } from './primitives/Modal';

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
    <Modal
      isOpen={showAuthModal}
      onClose={onClose}
      title={mode === 'signin' ? '登录' : '注册'}
      size="md"
    >
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
        <FormField label="邮箱">
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="your@email.com"
            required
          />
        </FormField>
        <FormField label="密码">
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="至少6位"
            required
            minLength={6}
          />
        </FormField>

        {mode === 'signup' && (
          <FormField
            label="邀请码"
            required
            hint="需要邀请码才能注册，请联系管理员获取"
          >
            <Input
              type="text"
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
              placeholder="输入邀请码"
              required
            />
          </FormField>
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
    </Modal>
  );
};
