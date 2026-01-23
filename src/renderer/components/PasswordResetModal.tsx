// ============================================================================
// Password Reset Modal - Set new password after clicking reset link
// ============================================================================

import React, { useState } from 'react';
import { useAuthStore } from '../stores/authStore';
import { Loader2, KeyRound, CheckCircle, Eye, EyeOff } from 'lucide-react';
import { FormField, Input } from './composites/FormField';
import { Modal } from './primitives/Modal';

export const PasswordResetModal: React.FC = () => {
  const {
    updatePassword,
    isLoading,
    error,
    showPasswordResetModal,
    setShowPasswordResetModal,
    setError,
  } = useAuthStore();

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [success, setSuccess] = useState(false);

  if (!showPasswordResetModal) return null;

  const onClose = () => {
    setShowPasswordResetModal(false);
    setPassword('');
    setConfirmPassword('');
    setSuccess(false);
    setError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Validate passwords match
    if (password !== confirmPassword) {
      setError('两次输入的密码不一致');
      return;
    }

    // Validate password strength
    if (password.length < 6) {
      setError('密码长度至少为6位');
      return;
    }

    const result = await updatePassword(password);
    if (result) {
      setSuccess(true);
    }
  };

  return (
    <Modal
      isOpen={showPasswordResetModal}
      onClose={onClose}
      title="设置新密码"
      size="md"
    >
      {/* Error message */}
      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
          {error}
        </div>
      )}

      {success ? (
        /* Success message */
        <div className="py-6 text-center space-y-4">
          <CheckCircle className="w-12 h-12 text-green-500 mx-auto" />
          <div className="space-y-2">
            <p className="text-zinc-200 font-medium">密码已更新</p>
            <p className="text-zinc-400 text-sm">
              您的密码已成功重置，现在可以使用新密码登录了。
            </p>
          </div>
          <button
            onClick={onClose}
            className="mt-4 px-6 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm font-medium transition-colors"
          >
            完成
          </button>
        </div>
      ) : (
        /* Reset form */
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="flex items-center gap-2 p-3 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-400 text-sm mb-4">
            <KeyRound className="w-4 h-4 flex-shrink-0" />
            <span>请设置您的新密码</span>
          </div>

          <FormField label="新密码">
            <div className="relative">
              <Input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="至少6位"
                required
                minLength={6}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-300"
              >
                {showPassword ? (
                  <EyeOff className="w-4 h-4" />
                ) : (
                  <Eye className="w-4 h-4" />
                )}
              </button>
            </div>
          </FormField>

          <FormField label="确认密码">
            <Input
              type={showPassword ? 'text' : 'password'}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="再次输入密码"
              required
              minLength={6}
            />
          </FormField>

          {/* Password strength indicator */}
          {password && (
            <div className="space-y-1">
              <div className="flex gap-1">
                <div
                  className={`h-1 flex-1 rounded ${
                    password.length >= 6 ? 'bg-green-500' : 'bg-zinc-600'
                  }`}
                />
                <div
                  className={`h-1 flex-1 rounded ${
                    password.length >= 8 ? 'bg-green-500' : 'bg-zinc-600'
                  }`}
                />
                <div
                  className={`h-1 flex-1 rounded ${
                    password.length >= 10 && /[A-Z]/.test(password) && /[0-9]/.test(password)
                      ? 'bg-green-500'
                      : 'bg-zinc-600'
                  }`}
                />
              </div>
              <p className="text-xs text-zinc-500">
                {password.length < 6
                  ? '密码太短'
                  : password.length < 8
                  ? '密码强度：弱'
                  : password.length < 10 || !/[A-Z]/.test(password) || !/[0-9]/.test(password)
                  ? '密码强度：中'
                  : '密码强度：强'}
              </p>
            </div>
          )}

          <button
            type="submit"
            disabled={isLoading || password !== confirmPassword || password.length < 6}
            className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-white font-medium flex items-center justify-center gap-2 transition-colors min-h-[42px]"
          >
            {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
            确认修改
            {isLoading && '...'}
          </button>
        </form>
      )}
    </Modal>
  );
};
