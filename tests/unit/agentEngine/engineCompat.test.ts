import { describe, expect, it } from 'vitest';
import {
  ENGINE_BILLING_MODE,
  ENGINE_BILLING_MODES,
  ENGINE_MODEL_COMPAT_REASON_CODES,
  engineBillingModeIsAuthoritative,
  getEngineBillingMode,
  getEngineModelCompat,
} from '../../../src/shared/constants/engineCompat';
import { AGENT_ENGINE_KINDS } from '../../../src/shared/contract/agentEngine';

describe('engineCompat — billingMode 映射', () => {
  it('每个引擎都有出厂计费模式且取值在枚举内', () => {
    for (const kind of AGENT_ENGINE_KINDS) {
      const mode = getEngineBillingMode(kind);
      expect(ENGINE_BILLING_MODES).toContain(mode);
      expect(ENGINE_BILLING_MODE[kind]).toBe(mode);
    }
  });

  it('native = api_key_payg（随 provider 按量），外部 CLI 引擎 = subscription（经登录吃额度）', () => {
    expect(getEngineBillingMode('native')).toBe('api_key_payg');
    expect(getEngineBillingMode('codex_cli')).toBe('subscription');
    expect(getEngineBillingMode('claude_code')).toBe('subscription');
    expect(getEngineBillingMode('mimo_code')).toBe('subscription');
    expect(getEngineBillingMode('kimi_code')).toBe('subscription');
  });

  it('只有 native 的计费需结合 provider 才能确定（非权威），外部引擎权威', () => {
    expect(engineBillingModeIsAuthoritative('native')).toBe(false);
    expect(engineBillingModeIsAuthoritative('codex_cli')).toBe(true);
    expect(engineBillingModeIsAuthoritative('claude_code')).toBe(true);
    expect(engineBillingModeIsAuthoritative('mimo_code')).toBe(true);
    expect(engineBillingModeIsAuthoritative('kimi_code')).toBe(true);
  });
});

describe('engineCompat — getEngineModelCompat 判定', () => {
  it('未显式指定模型（空/空白）时一律 supported 且不带原因码（走引擎默认）', () => {
    for (const kind of AGENT_ENGINE_KINDS) {
      expect(getEngineModelCompat(kind, undefined)).toEqual({ supported: true });
      expect(getEngineModelCompat(kind, '')).toEqual({ supported: true });
      expect(getEngineModelCompat(kind, '   ')).toEqual({ supported: true });
    }
  });

  describe('native — 按 provider 注册表判定', () => {
    it('注入的 isRegisteredNativeModel 命中 → supported，无原因码', () => {
      const result = getEngineModelCompat('native', 'gpt-5.5', {
        isRegisteredNativeModel: (id) => id === 'gpt-5.5',
      });
      expect(result).toEqual({ supported: true });
    });

    it('解析不到注册 provider → unsupported + provider_not_registered', () => {
      const result = getEngineModelCompat('native', 'totally-unknown', {
        isRegisteredNativeModel: () => false,
      });
      expect(result).toEqual({ supported: false, reasonCode: 'provider_not_registered' });
    });

    it('未注入判定器时默认放行（兼容旧调用方）', () => {
      expect(getEngineModelCompat('native', 'anything')).toEqual({ supported: true });
    });
  });

  describe('codex / claude — 仅签名目录内已启用模型', () => {
    const ctx = {
      signedCatalogEnabledModelIds: new Set(['gpt-5-codex', 'o4-mini']),
      signedCatalogDisabledModelIds: new Set(['legacy-codex']),
    };

    it('目录内已启用 → supported', () => {
      expect(getEngineModelCompat('codex_cli', 'gpt-5-codex', ctx)).toEqual({ supported: true });
      expect(getEngineModelCompat('claude_code', 'o4-mini', ctx)).toEqual({ supported: true });
    });

    it('目录内被停用 → unsupported + disabled_in_catalog', () => {
      expect(getEngineModelCompat('codex_cli', 'legacy-codex', ctx)).toEqual({
        supported: false,
        reasonCode: 'disabled_in_catalog',
      });
    });

    it('不在目录里 → unsupported + not_in_signed_catalog（fail-closed）', () => {
      expect(getEngineModelCompat('claude_code', 'gpt-5.5', ctx)).toEqual({
        supported: false,
        reasonCode: 'not_in_signed_catalog',
      });
    });

    it('未提供目录上下文时，任何具体模型都判为不在目录（保守 fail-closed）', () => {
      expect(getEngineModelCompat('codex_cli', 'gpt-5-codex')).toEqual({
        supported: false,
        reasonCode: 'not_in_signed_catalog',
      });
    });

    it('数组形式的 id 集合与 Set 等价', () => {
      const arrCtx = { signedCatalogEnabledModelIds: ['gpt-5-codex'] };
      expect(getEngineModelCompat('codex_cli', 'gpt-5-codex', arrCtx)).toEqual({ supported: true });
    });
  });

  describe('mimo / kimi — 直传任意模型，由 CLI 解析', () => {
    it('任意模型都 supported，但带 resolved_by_cli 注解', () => {
      expect(getEngineModelCompat('mimo_code', 'mimo-v2.5-pro')).toEqual({
        supported: true,
        reasonCode: 'resolved_by_cli',
      });
      expect(getEngineModelCompat('kimi_code', 'kimi-k2.5')).toEqual({
        supported: true,
        reasonCode: 'resolved_by_cli',
      });
    });
  });

  it('所有返回的 reasonCode 都在枚举集合内', () => {
    const samples = [
      getEngineModelCompat('native', 'x', { isRegisteredNativeModel: () => false }),
      getEngineModelCompat('codex_cli', 'x', { signedCatalogDisabledModelIds: ['x'] }),
      getEngineModelCompat('claude_code', 'x'),
      getEngineModelCompat('mimo_code', 'x'),
    ];
    for (const sample of samples) {
      if (sample.reasonCode) {
        expect(ENGINE_MODEL_COMPAT_REASON_CODES).toContain(sample.reasonCode);
      }
    }
  });
});
