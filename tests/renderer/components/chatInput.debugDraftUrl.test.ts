import { describe, expect, it } from 'vitest';
import {
  clearDebugDraftParamsFromUrl,
  readDebugDraftFromLocation,
} from '../../../src/renderer/components/features/chat/ChatInput/debugDraftUrl';

describe('ChatInput debug draft URL', () => {
  it('reads local debug draft content and submit flag', () => {
    const result = readDebugDraftFromLocation({
      hostname: '127.0.0.1',
      search: '?__neoDraft=%E7%9C%9F%E5%AE%9Ecowork&__neoSubmit=1',
    });

    expect(result).toEqual({
      content: '真实cowork',
      autoSubmit: true,
    });
  });

  it('ignores non-local hosts', () => {
    const result = readDebugDraftFromLocation({
      hostname: 'agentneo.vercel.app',
      search: '?__neoDraft=secret&__neoSubmit=1',
    });

    expect(result).toBeNull();
  });

  it('clears only debug draft params from the URL', () => {
    const url = new URL('http://127.0.0.1:53779/?keep=1&__neoDraft=hello&__neoSubmit=true#chat');

    expect(clearDebugDraftParamsFromUrl(url)).toBe('/?keep=1#chat');
  });
});
