// ============================================================================
// Auth Modal - Login/Register dialog
// ============================================================================

import React, { useState, useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';
import { Loader2, UserPlus, LogIn, KeyRound, ArrowLeft, CheckCircle } from 'lucide-react';
import { FormField, Input } from './composites/FormField';
import { Modal } from './primitives/Modal';

type AuthMode = 'signin' | 'signup' | 'reset';

export const AuthModal: React.FC = () => {
  const {
    signInWithEmail,
    signUpWithEmail,
    resetPassword,
    isLoading,
    error,
    showAuthModal,
    setShowAuthModal,
    setError,
  } = useAuthStore();

  const [mode, setMode] = useState<AuthMode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [rememberPassword, setRememberPassword] = useState(true);
  const [credentialsLoaded, setCredentialsLoaded] = useState(false);
  const [resetEmailSent, setResetEmailSent] = useState(false);

  // Load saved credentials when modal opens
  useEffect(() => {
    if (showAuthModal && mode === 'signin' && !credentialsLoaded) {
      loadSavedCredentials();
    }
  }, [showAuthModal, mode, credentialsLoaded]);

  const loadSavedCredentials = async () => {
    try {
      if (!window.domainAPI) return;
      const response = await window.domainAPI.invoke<{ email: string; password: string } | null>(
        'auth',
        'getSavedCredentials'
      );
      if (response.success && response.data) {
        setEmail(response.data.email);
        setPassword(response.data.password);
        setRememberPassword(true);
      }
      setCredentialsLoaded(true);
    } catch (err) {
      console.error('Failed to load saved credentials:', err);
      setCredentialsLoaded(true);
    }
  };

  const saveCredentials = async (emailToSave: string, passwordToSave: string) => {
    try {
      if (!window.domainAPI) return;
      await window.domainAPI.invoke('auth', 'saveCredentials', {
        email: emailToSave,
        password: passwordToSave,
      });
    } catch (err) {
      console.error('Failed to save credentials:', err);
    }
  };

  const clearCredentials = async () => {
    try {
      if (!window.domainAPI) return;
      await window.domainAPI.invoke('auth', 'clearSavedCredentials');
    } catch (err) {
      console.error('Failed to clear credentials:', err);
    }
  };

  if (!showAuthModal) return null;

  const onClose = () => {
    setShowAuthModal(false);
    // Reset credentials loaded flag so next time we reload
    setCredentialsLoaded(false);
  };

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    let success: boolean;

    if (mode === 'signin') {
      success = await signInWithEmail(email, password);
      // Save credentials on successful login if remember is checked
      if (success && rememberPassword) {
        await saveCredentials(email, password);
      } else if (success && !rememberPassword) {
        await clearCredentials();
      }
    } else if (mode === 'signup') {
      success = await signUpWithEmail(email, password, inviteCode || undefined);
      // Also save credentials after successful registration
      if (success && rememberPassword) {
        await saveCredentials(email, password);
      }
    } else {
      // reset mode
      success = await resetPassword(email);
      if (success) {
        setResetEmailSent(true);
        return; // Don't close modal, show success message
      }
      return;
    }

    if (success) {
      setEmail('');
      setPassword('');
      setInviteCode('');
      onClose();
    }
  };

  const handleModeChange = (newMode: AuthMode) => {
    setMode(newMode);
    setError(null);
    setResetEmailSent(false);
  };

  const getModalTitle = () => {
    if (mode === 'reset') return '找回密码';
    return mode === 'signin' ? '登录' : '注册';
  };

  return (
    <Modal
      isOpen={showAuthModal}
      onClose={onClose}
      title={getModalTitle()}
      size="md"
    >
      {/* Error message */}
      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* Reset password mode */}
      {mode === 'reset' ? (
        <div className="space-y-4">
          {/* Back button */}
          <button
            onClick={() => handleModeChange('signin')}
            className="flex items-center gap-1 text-sm text-zinc-400 hover:text-zinc-300 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            返回登录
          </button>

          {resetEmailSent ? (
            /* Success message */
            <div className="py-6 text-center space-y-4">
              <CheckCircle className="w-12 h-12 text-green-500 mx-auto" />
              <div className="space-y-2">
                <p className="text-zinc-200 font-medium">重置链接已发送</p>
                <p className="text-zinc-400 text-sm">
                  请检查您的邮箱 <span className="text-zinc-300">{email}</span>
                  <br />
                  点击邮件中的链接重置密码
                </p>
              </div>
              <button
                onClick={() => handleModeChange('signin')}
                className="mt-4 px-4 py-2 bg-zinc-700 hover:bg-zinc-600 rounded-lg text-sm transition-colors"
              >
                返回登录
              </button>
            </div>
          ) : (
            /* Reset form */
            <form onSubmit={handleEmailSubmit} className="space-y-4">
              <p className="text-zinc-400 text-sm">
                输入您的注册邮箱，我们将向您发送密码重置链接。
              </p>
              <FormField label="邮箱">
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="your@email.com"
                  required
                />
              </FormField>
              <button
                type="submit"
                disabled={isLoading}
                className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-white font-medium flex items-center justify-center gap-2 transition-colors min-h-[42px]"
              >
                {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                发送重置链接
                {isLoading && '...'}
              </button>
            </form>
          )}
        </div>
      ) : (
        /* Sign in / Sign up mode */
        <>
          {/* Mode tabs */}
          <div className="flex mb-6 border-b border-zinc-800">
            <button
              onClick={() => handleModeChange('signin')}
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
              onClick={() => handleModeChange('signup')}
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

            {/* Remember password checkbox */}
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={rememberPassword}
                onChange={(e) => setRememberPassword(e.target.checked)}
                className="w-4 h-4 rounded border-zinc-600 bg-zinc-800 text-blue-500 focus:ring-blue-500 focus:ring-offset-zinc-900"
              />
              <span className="text-sm text-zinc-400">记住密码</span>
            </label>

            <button
              type="submit"
              disabled={isLoading}
              className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-white font-medium flex items-center justify-center gap-2 transition-colors min-h-[42px]"
            >
              {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
              {mode === 'signin' ? '登录' : '注册'}
              {isLoading && '中...'}
            </button>

            {/* Forgot password link - only show in signin mode */}
            {mode === 'signin' && (
              <div className="text-center">
                <button
                  type="button"
                  onClick={() => handleModeChange('reset')}
                  className="text-sm text-zinc-400 hover:text-blue-400 transition-colors"
                >
                  <KeyRound className="w-3 h-3 inline mr-1" />
                  忘记密码？
                </button>
              </div>
            )}
          </form>
        </>
      )}
    </Modal>
  );
};
