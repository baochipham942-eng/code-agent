// ADR-081「旧客户端看到的那句话」的合同测试：zh 必须与 ADR 推荐原文逐字一致
// （docs/architecture/decisions/ADR-081-execution-environment.md §协议版本闸，
// 暂行、待爸复核），宿主只回稳定码 ENVIRONMENT_PROTOCOL_UNSUPPORTED，句子只在渲染端。
// 全部走公共入口 environmentProtocolUnsupportedMessage（错误 + 语言 → 文案）。

import { describe, expect, it } from 'vitest';
import { environmentProtocolUnsupportedMessage } from '../../../src/renderer/i18n/executionEnvironment';
import { ENVIRONMENT_PROTOCOL_UNSUPPORTED } from '../../../src/shared/contract/executionEnvironment';

const ADR_RECOMMENDED_ZH = '这个客户端还不会选择执行环境。请更新之后，再把这一轮放到云端或另一台电脑上。这一轮没有开始。';

const rejection = Object.assign(
  new Error('云端代理请求失败 (400): ENVIRONMENT_PROTOCOL_UNSUPPORTED'),
  { status: 400, code: ENVIRONMENT_PROTOCOL_UNSUPPORTED },
);

describe('executionEnvironment i18n（ADR-081 协议版本闸旧客户端文案）', () => {
  it('④ zh 文案与 ADR-081 推荐原文逐字一致', () => {
    expect(environmentProtocolUnsupportedMessage(rejection, 'zh')).toBe(ADR_RECOMMENDED_ZH);
  });

  it('④ en 文案与 zh 一一对应且不回落到 zh', () => {
    const en = environmentProtocolUnsupportedMessage(rejection, 'en');
    expect(en).not.toBe(ADR_RECOMMENDED_ZH);
    // 三句话结构对应：不会选环境 / 更新后再放云端或另一台电脑 / 这一轮没有开始
    expect(en).toContain('execution environment');
    expect(en).toContain('cloud or another computer');
    expect(en).toContain('has not started');
  });

  it('带稳定码的裸对象（无 Error 包装）也能命中', () => {
    expect(environmentProtocolUnsupportedMessage({ code: ENVIRONMENT_PROTOCOL_UNSUPPORTED }, 'zh'))
      .toBe(ADR_RECOMMENDED_ZH);
  });

  it('其他错误码 / 非对象错误 → undefined，交回原有报错路径', () => {
    expect(environmentProtocolUnsupportedMessage(new Error('network down'), 'zh')).toBeUndefined();
    expect(environmentProtocolUnsupportedMessage(Object.assign(new Error('x'), { code: 'OTHER_CODE' }), 'zh')).toBeUndefined();
    expect(environmentProtocolUnsupportedMessage('ENVIRONMENT_PROTOCOL_UNSUPPORTED', 'zh')).toBeUndefined();
    expect(environmentProtocolUnsupportedMessage(null, 'zh')).toBeUndefined();
  });

  it('稳定码只此一个写法（宿主与渲染端共用同一常量）', () => {
    expect(ENVIRONMENT_PROTOCOL_UNSUPPORTED).toBe('ENVIRONMENT_PROTOCOL_UNSUPPORTED');
  });
});
