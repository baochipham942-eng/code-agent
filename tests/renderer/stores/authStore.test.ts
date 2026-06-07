import { describe, expect, it } from 'vitest';
import { formatAuthErrorMessage } from '../../../src/renderer/stores/authStore';

describe('formatAuthErrorMessage', () => {
  it('hides Supabase initialization details from login UI', () => {
    expect(formatAuthErrorMessage('Supabase not initialized')).toBe('登录服务启动失败，请重启应用或检查网络后重试。');
    expect(formatAuthErrorMessage('Supabase not initialized. Call initSupabase first.')).toBe('登录服务启动失败，请重启应用或检查网络后重试。');
    expect(formatAuthErrorMessage('AUTH_BACKEND_UNAVAILABLE')).toBe('登录服务启动失败，请重启应用或检查网络后重试。');
  });

  it('keeps ordinary auth errors unchanged', () => {
    expect(formatAuthErrorMessage('Invalid login credentials')).toBe('Invalid login credentials');
  });
});
