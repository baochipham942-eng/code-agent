import { describe, it, expect, vi } from 'vitest';
vi.mock('../../../src/host/services/core/secureStorage', () => ({
  getSecureStorage: () => ({ getApiKey: (p: string) => (p === 'custom-agnes' ? 'sk-agnes' : '') }),
}));
import { resolveBridgedEndpoint } from '../../../src/host/services/media/bridgedEndpoint';

describe('resolveBridgedEndpoint', () => {
  it('按源 provider 取 baseUrl+key 并过 SSRF 守卫', () => {
    const settings = { models: { providers: { 'custom-agnes': { baseUrl: 'https://apihub.agnes-ai.com/v1' } } } } as any;
    expect(resolveBridgedEndpoint('custom-agnes', settings)).toEqual({ baseUrl: 'https://apihub.agnes-ai.com/v1', apiKey: 'sk-agnes' });
  });
  it('缺 key 抛错', () => {
    const settings = { models: { providers: { 'custom-x': { baseUrl: 'https://x.com/v1' } } } } as any;
    expect(() => resolveBridgedEndpoint('custom-x', settings)).toThrow(/API Key/);
  });
  it('缺 baseUrl 抛错', () => {
    const settings = { models: { providers: { 'custom-agnes': {} } } } as any;
    expect(() => resolveBridgedEndpoint('custom-agnes', settings)).toThrow(/baseUrl/);
  });
});
