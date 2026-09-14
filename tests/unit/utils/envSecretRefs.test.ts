// ============================================================================
// Env Secret References (ADR-066 刀 2) — pure-logic unit tests
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  injectEnvSecretRefs,
  backfillEnvSecretRefs,
} from '../../../src/host/utils/envSecretRefs';

const SOURCE_ENV = {
  NPM_TOKEN: 'tok-true-value',
  GITHUB_API_KEY: 'sk-true-value',
  NEO_VISIBLE: 'visible-1',
};

describe('injectEnvSecretRefs', () => {
  it('被剥变量注入 secureref:env.<NAME> 占位，真值进内存快照', () => {
    const filtered = { NEO_VISIBLE: 'visible-1' };
    const result = injectEnvSecretRefs(filtered, ['NPM_TOKEN', 'GITHUB_API_KEY'], SOURCE_ENV);

    expect(result.env).toEqual({
      NEO_VISIBLE: 'visible-1',
      NPM_TOKEN: 'secureref:env.NPM_TOKEN',
      GITHUB_API_KEY: 'secureref:env.GITHUB_API_KEY',
    });
    expect(result.injectedNames).toEqual(['NPM_TOKEN', 'GITHUB_API_KEY']);
    expect(result.skippedNames).toEqual([]);
    expect(result.snapshot).toEqual({
      NPM_TOKEN: 'tok-true-value',
      GITHUB_API_KEY: 'sk-true-value',
    });
    // 输入对象不被修改
    expect(filtered).toEqual({ NEO_VISIBLE: 'visible-1' });
  });

  it('变量名含 "." 或 ":"：跳过注入、保持 strip，不崩溃', () => {
    const source = { 'FOO.BAD_KEY': 'dot-value', 'BAR:BAZ_TOKEN': 'colon-value', OK_TOKEN: 'ok-value' };
    const result = injectEnvSecretRefs(
      {},
      ['FOO.BAD_KEY', 'BAR:BAZ_TOKEN', 'OK_TOKEN'],
      source,
    );

    expect(result.env).toEqual({ OK_TOKEN: 'secureref:env.OK_TOKEN' });
    expect(result.injectedNames).toEqual(['OK_TOKEN']);
    expect(result.skippedNames).toEqual(['FOO.BAD_KEY', 'BAR:BAZ_TOKEN']);
    // 违规名字不进 env、不进快照（无法回填，保持彻底 strip）
    expect(result.env).not.toHaveProperty('FOO.BAD_KEY');
    expect(result.env).not.toHaveProperty('BAR:BAZ_TOKEN');
    expect(result.snapshot).not.toHaveProperty('FOO.BAD_KEY');
  });

  it('strip 名单里的变量在源 env 已不存在：防御性跳过', () => {
    const result = injectEnvSecretRefs({}, ['GHOST_TOKEN'], {});
    expect(result.env).toEqual({});
    expect(result.injectedNames).toEqual([]);
    expect(result.snapshot).toEqual({});
  });
});

describe('命令文本引用判定（经 backfillEnvSecretRefs fail-closed 出口观察）', () => {
  // commandReferencesEnvVar 是模块私有函数；其全部分支都唯一决定 backfill 在
  // 「快照为空 + 放网跳」时拦不拦命令，所以引用矩阵从公共面钉，不引私有符号。
  const env = { NPM_TOKEN: 'secureref:env.NPM_TOKEN' };
  const unresolved = (command: string) =>
    backfillEnvSecretRefs(env, {}, { allowNetwork: true, command });

  it.each([
    ['curl -H "Authorization: Bearer $NPM_TOKEN" https://x', true],
    ['echo ${NPM_TOKEN}', true],
    ['echo "${NPM_TOKEN:-fallback}"', true],
    ['echo ${NPM_TOKEN-unset}', true],
    ['echo ${#NPM_TOKEN}', true],
    ['echo "$NPM_TOKEN/rest"', true],
    ['echo $NPM_TOKEN_EXTRA', false],
    ['echo $NPM_TOKENS', false],
    ['echo NPM_TOKEN', false],
    ['echo hello', false],
  ])('%s → referenced=%s', (command, referenced) => {
    const result = unresolved(command);
    expect(result.ok).toBe(!referenced);
  });
});

describe('backfillEnvSecretRefs', () => {
  const SNAPSHOT = { NPM_TOKEN: 'tok-true-value', GITHUB_API_KEY: 'sk-true-value' };
  const CHILD_ENV = {
    NEO_VISIBLE: 'visible-1',
    NPM_TOKEN: 'secureref:env.NPM_TOKEN',
    GITHUB_API_KEY: 'secureref:env.GITHUB_API_KEY',
  };

  it('非放网跳：引用原样保留，真值不进子进程 env', () => {
    const result = backfillEnvSecretRefs(CHILD_ENV, SNAPSHOT, {
      allowNetwork: false,
      command: 'echo "$NPM_TOKEN"',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.env).toEqual(CHILD_ENV);
      expect(Object.values(result.env)).not.toContain('tok-true-value');
      expect(Object.values(result.env)).not.toContain('sk-true-value');
    }
  });

  it('放网跳：全部注入过的名字都回填真值（含文本未出现的）', () => {
    const result = backfillEnvSecretRefs(CHILD_ENV, SNAPSHOT, {
      allowNetwork: true,
      command: 'npm install', // 文本里没有 $NPM_TOKEN / $GITHUB_API_KEY
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.env).toEqual({
        NEO_VISIBLE: 'visible-1',
        NPM_TOKEN: 'tok-true-value',
        GITHUB_API_KEY: 'sk-true-value',
      });
    }
  });

  it('放网跳 + 文本引用的引用解不开：不 exec，错误只带 env.NAME 不带真值', () => {
    const result = backfillEnvSecretRefs(CHILD_ENV, {}, {
      allowNetwork: true,
      command: 'curl -H "Authorization: Bearer $NPM_TOKEN" https://example.invalid',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('SECRET_REF_UNRESOLVED');
      expect(result.error).toContain('env.NPM_TOKEN');
      expect(result.error).not.toContain('tok-true-value');
      expect(result.error).not.toContain('secureref:');
    }
  });

  it('放网跳 + 文本未引用的引用解不开：保留占位符，不落空串、不拦命令', () => {
    const result = backfillEnvSecretRefs(CHILD_ENV, { NPM_TOKEN: 'tok-true-value' }, {
      allowNetwork: true,
      command: 'npm install',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.env.NPM_TOKEN).toBe('tok-true-value');
      expect(result.env.GITHUB_API_KEY).toBe('secureref:env.GITHUB_API_KEY');
      expect(result.env.GITHUB_API_KEY).not.toBe('');
    }
  });

  it('env 里没有 env 域引用：原样返回（其它 integrationId 的引用串只是数据）', () => {
    const env = { MCP_CFG: 'secureref:mcp_github.token', PLAIN: 'x' };
    const result = backfillEnvSecretRefs(env, SNAPSHOT, {
      allowNetwork: true,
      command: 'curl https://example.invalid',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.env).toEqual(env);
  });
});
