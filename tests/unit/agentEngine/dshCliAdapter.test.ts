import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildDshArgs,
  buildDshEnv,
  parseDshLine,
} from '../../../src/host/services/agentEngine/dshCliAdapter';

describe('DshCliAdapter protocol', () => {
  it('builds a headless one-shot invocation and omits the patch when no model is chosen', () => {
    expect(buildDshArgs('read_only', undefined, 'nonce')).toEqual([
      '--profile',
      'headless',
      'nonce',
    ]);
    expect(buildDshArgs('read_only', 'client_default', 'nonce')).toEqual([
      '--profile',
      'headless',
      'nonce',
    ]);
  });

  it('translates a provider/model selection into a --patch overlay', () => {
    const args = buildDshArgs('read_only', 'deepseek-official/deepseek-v4-pro', 'nonce');
    expect(args.slice(0, 2)).toEqual(['--profile', 'headless']);
    expect(args[2]).toBe('--patch');
    expect(args[4]).toBe('nonce');
    // dsh 的 --patch 是整块替换而非深合并，provider 必须和 model 一起写进去。
    expect(fs.readFileSync(args[3], 'utf8')).toBe(
      '- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: deepseek-v4-pro\n',
    );
  });

  it('refuses a model that carries no provider or smuggles YAML', () => {
    expect(() => buildDshArgs('read_only', 'deepseek-v4-pro', 'nonce')).toThrow(/<provider>\/<model>/);
    expect(() => buildDshArgs('read_only', '/deepseek-v4-pro', 'nonce')).toThrow(/<provider>\/<model>/);
    expect(() => buildDshArgs('read_only', 'p/m\n    task: pwned', 'nonce')).toThrow(/只允许字母/);
  });

  it('keeps every stdout line as real text, blank lines included', () => {
    // headless 没有事件流，stdout 就是最终回答本身；空行丢了会毁掉 markdown 段落。
    expect(parseDshLine('第一段')).toEqual({ textDelta: '第一段\n', textDeltaSource: 'stream' });
    expect(parseDshLine('')).toEqual({ textDelta: '\n', textDeltaSource: 'stream' });
  });

  it('pins the read-only sandbox, withholds proxies, and forwards no credentials', () => {
    const previous = {
      key: process.env.OPENAI_API_KEY,
      deepseek: process.env.DEEPSEEK_API_KEY,
      proxy: process.env.HTTPS_PROXY,
    };
    process.env.OPENAI_API_KEY = 'must-not-forward';
    process.env.DEEPSEEK_API_KEY = 'must-not-forward';
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7897';
    try {
      const env = buildDshEnv();
      expect(env.OPENAI_API_KEY).toBeUndefined();
      // 密钥归 dsh 自己的 ~/.dsh 管，Neo 不读不传。
      expect(env.DEEPSEEK_API_KEY).toBeUndefined();
      // dsh 直连 api.deepseek.com，带上本机代理只会打不通。
      expect(env.HTTPS_PROXY).toBeUndefined();
      expect(env.HTTP_PROXY).toBeUndefined();
      // Neo 声明的 read_only 档必须真下发给 dsh 自己的沙箱，否则它默认 workspace-write。
      expect(env.DSH_PERMISSION_MODE).toBe('read-only');
      expect(env.HOME).toBeTruthy();
      expect(env.PATH).toBeTruthy();
    } finally {
      for (const [key, value] of [
        ['OPENAI_API_KEY', previous.key],
        ['DEEPSEEK_API_KEY', previous.deepseek],
        ['HTTPS_PROXY', previous.proxy],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('reuses one patch file per provider/model pair', () => {
    const first = buildDshArgs('read_only', 'deepseek-official/deepseek-v4-flash', 'nonce')[3];
    const second = buildDshArgs('read_only', 'deepseek-official/deepseek-v4-flash', 'nonce')[3];
    expect(second).toBe(first);
  });
});
