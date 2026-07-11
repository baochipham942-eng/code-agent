import { describe, expect, it } from 'vitest';
import { formatAuthErrorMessage } from '../../../src/renderer/stores/authStore';

describe('formatAuthErrorMessage', () => {
  it('hides Supabase initialization details from login UI', () => {
    expect(formatAuthErrorMessage('Supabase not initialized')).toBe('登录服务启动失败，请重启应用或检查网络后重试。');
    expect(formatAuthErrorMessage('Supabase not initialized. Call initSupabase first.')).toBe('登录服务启动失败，请重启应用或检查网络后重试。');
    expect(formatAuthErrorMessage('AUTH_BACKEND_UNAVAILABLE')).toBe('登录服务启动失败，请重启应用或检查网络后重试。');
  });

  it('turns empty object and network failures into an actionable reachability hint', () => {
    expect(formatAuthErrorMessage('{}')).toBe('登录服务暂时连不上，请检查网络或代理设置后重试。');
    expect(formatAuthErrorMessage('[object Object]')).toBe('登录服务暂时连不上，请检查网络或代理设置后重试。');
    expect(formatAuthErrorMessage('AUTH_REQUEST_FAILED')).toBe('登录服务暂时连不上，请检查网络或代理设置后重试。');
    expect(formatAuthErrorMessage('TypeError: fetch failed')).toBe('登录服务暂时连不上，请检查网络或代理设置后重试。');
    expect(formatAuthErrorMessage('Error: write EPIPE')).toBe('登录服务暂时连不上，请检查网络或代理设置后重试。');
    expect(formatAuthErrorMessage({})).toBe('登录服务暂时连不上，请检查网络或代理设置后重试。');
    expect(formatAuthErrorMessage({ error: { message: 'connect ECONNREFUSED 127.0.0.1:7897' } })).toBe('登录服务暂时连不上，请检查网络或代理设置后重试。');
  });

  it('localizes common Supabase auth errors', () => {
    expect(formatAuthErrorMessage('Invalid login credentials')).toBe('邮箱或密码不正确，请检查后重试。');
    expect(formatAuthErrorMessage('Email not confirmed')).toBe('邮箱还没有完成验证，请先打开验证邮件。');
    expect(formatAuthErrorMessage('User already registered')).toBe('这个邮箱已经注册过了，请直接登录或找回密码。');
  });

  it('keeps uncommon auth errors visible', () => {
    expect(formatAuthErrorMessage('Invite code has expired')).toBe('Invite code has expired');
  });
});
