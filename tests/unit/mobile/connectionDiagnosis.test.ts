import { describe, expect, it } from 'vitest';
import { messages } from '../../../packages/mobile/src/i18n';
import { connectionDiagnosis, lastSyncCopy } from '../../../packages/mobile/src/app/connectionDiagnosis';
import { classifyHttpFailure } from '../../../packages/mobile/src/platform/httpFailure';

// fix4-②（2026-09-15）：连接失败上抛三类，UI 给三句人话——①电脑没回应（超时/无响应）
// ②电脑上的 Neo 没在运行（连接被拒绝）③配对信息已失效（握手/身份失败，重连救不回，要扫码）。
const text = messages('zh');

describe('connectionDiagnosis：三分类 → 一句人话 + 主动作', () => {
  const state = (connectionError: string | null) => ({ connectionError });

  it('① 超时/无响应（含未知网络失败）→ 电脑没回应 + 重新连接', () => {
    for (const error of [null, 'connectionUnavailable', 'connectionFailed']) {
      expect(connectionDiagnosis(text, state(error))).toEqual({ sentence: text.connectionUnavailable, action: 'reconnect' });
    }
    expect(text.connectionUnavailable).toContain('电脑没回应');
    // 承重点是「说出两个最可能的原因」，不是某个措辞（N-MOBILE-CONNCOPY-PLAIN 改过一次用词）。
    expect(text.connectionUnavailable).toContain('睡');
    expect(text.connectionUnavailable).toContain('网络');
  });

  it('② 连接被拒绝 → Neo 没在运行 + 重新连接', () => {
    expect(connectionDiagnosis(text, state('connectionRefused'))).toEqual({ sentence: text.connectionRefused, action: 'reconnect' });
    expect(text.connectionRefused).toContain('没在运行');
  });

  it('③ 握手/身份失败 → 配对失效 + 扫码（重连救不回）', () => {
    expect(connectionDiagnosis(text, state('connectionRejected'))).toEqual({ sentence: text.connectionRejected, action: 'scan' });
    expect(text.connectionRejected).toContain('重新扫码');
  });

  it('二维码类失败同样走扫码动作，但保留各自的句子', () => {
    expect(connectionDiagnosis(text, state('connectionQrInvalid'))).toEqual({ sentence: text.connectionQrInvalid, action: 'scan' });
    expect(connectionDiagnosis(text, state('connectionScanFailed'))).toEqual({ sentence: text.connectionScanFailed, action: 'scan' });
  });

  it('en 侧三句与动作同构（i18n 键位由类型钉死，这里钉内容存在）', () => {
    const en = messages('en');
    expect(connectionDiagnosis(en, state('connectionRefused')).sentence).toBe(en.connectionRefused);
    expect(en.connectionUnavailable).toContain('not responding');
  });

  // N-MOBILE-RELAY-PHONE：LAN 与跨网中继都没走通时的档——主动作仍是重连（重连先试 LAN 再落
  // relay，不是重新扫码）。**文案里不再出现「中继」这个实现词**（N-MOBILE-CONNCOPY-PLAIN）：
  // 用户对中继做不了任何事，把它写出来只会让人以为自己漏了一步。
  it('④ 两条路都没走通：各自的句子 + 重新连接，句子里说「连不上电脑」而不是「中继」', () => {
    expect(connectionDiagnosis(text, state('connectionRelayUnavailable')))
      .toEqual({ sentence: text.connectionRelayUnavailable, action: 'reconnect' });
    expect(connectionDiagnosis(text, state('connectionRelayRejected')))
      .toEqual({ sentence: text.connectionRelayRejected, action: 'reconnect' });
    expect(text.connectionRelayUnavailable).toContain('连不上电脑');
    expect(text.connectionRelayRejected).toContain('电脑');
  });
});

describe('lastSyncCopy：上次同步 x 分钟前', () => {
  const now = 1_700_000_000_000;
  it('没同步过返回 null——不编一个时间', () => {
    expect(lastSyncCopy(text, null, now)).toBeNull();
  });
  it('一分钟内说「刚刚」', () => {
    expect(lastSyncCopy(text, now - 30_000, now)).toBe(text.lastSyncJustNow);
  });
  it('分钟/小时档', () => {
    expect(lastSyncCopy(text, now - 5 * 60_000, now)).toBe('上次同步 5 分钟前');
    expect(lastSyncCopy(text, now - 59 * 60_000, now)).toBe('上次同步 59 分钟前');
    expect(lastSyncCopy(text, now - 60 * 60_000, now)).toBe('上次同步 1 小时前');
    expect(lastSyncCopy(text, now - 125 * 60_000, now)).toBe('上次同步 2 小时前');
  });
});

describe('classifyHttpFailure：原生 HTTP 失败分类（信号源见 httpFailure.ts 头注）', () => {
  it('Android：异常类名 code 与 ECONNREFUSED message 都认拒绝', () => {
    expect(classifyHttpFailure({ code: 'ConnectException', message: 'Failed to connect to /192.168.1.2:8182' })).toBe('COMPANION_CONNECTION_REFUSED');
    expect(classifyHttpFailure(new Error('failed to connect to /192.168.1.2:8182 (ECONNREFUSED)'))).toBe('COMPANION_CONNECTION_REFUSED');
  });
  it('iOS：URLSession 的固定文案分拒绝/超时', () => {
    expect(classifyHttpFailure({ code: 'NSURLErrorDomain', message: 'Could not connect to the server.' })).toBe('COMPANION_CONNECTION_REFUSED');
    expect(classifyHttpFailure({ code: 'NSURLErrorDomain', message: 'The request timed out' })).toBe('COMPANION_NO_RESPONSE');
  });
  it('Android：SocketTimeoutException 认超时', () => {
    expect(classifyHttpFailure({ code: 'SocketTimeoutException', message: 'timeout' })).toBe('COMPANION_NO_RESPONSE');
    expect(classifyHttpFailure({ code: 'IOException', message: 'Read timed out' })).toBe('COMPANION_NO_RESPONSE');
  });
  it('分不出的回退通用网络失败（诊断句落到「没回应」类，不会更错）', () => {
    expect(classifyHttpFailure({ code: 'NSURLErrorDomain', message: 'The Internet connection appears to be offline.' })).toBe('COMPANION_NETWORK_UNAVAILABLE');
    expect(classifyHttpFailure(new Error('boom'))).toBe('COMPANION_NETWORK_UNAVAILABLE');
    expect(classifyHttpFailure(undefined)).toBe('COMPANION_NETWORK_UNAVAILABLE');
  });
});

/**
 * N-MOBILE-CONNCOPY-PLAIN（爸 2026-09-16 build 42 真机：「明明在同一个网络下，而且还这么多
 * 技术术语」）。两条判据，都钉在「用户读到什么」上：
 * ① 用户面一个内部实现词都不许有；
 * ② 给出的动作必须在**任何**网络形态下成立——原文案让用户「回电脑的 Wi-Fi 重连一次」，
 *    而他电脑连的就是这台手机的热点，根本没有别的 Wi-Fi 可回。
 * 逐条遍历所有连接失败文案，不只看被点名的那一条。
 */
describe('连接失败文案：说人话，且给的动作得做得到', () => {
  const zh = messages('zh');
  const en = messages('en');
  const keys = ['connectionQrInvalid', 'connectionScanFailed', 'connectionRejected',
    'connectionRefused', 'connectionUnavailable', 'connectionRelayUnavailable', 'connectionRelayRejected'] as const;

  it('零内部实现词', () => {
    // 「中继 / 路由 / relay / mDNS / .local / 端口」都是实现细节，用户没有任何办法对它们做事。
    const banned = [/中继/, /路由/, /relay/i, /mDNS/i, /\.local/, /端口/, /IP 地址/];
    for (const key of keys) {
      for (const [lang, copy] of [['zh', zh[key]], ['en', en[key]]] as const) {
        // 只拿**文案本身**去匹配：把 key 名拼进去的话，connectionRelay* 这几个键名自己就会
        // 命中 /relay/i，判据变成恒红——错在判据，不在文案（第一版就是这么红的）。
        for (const pattern of banned) {
          expect(pattern.test(copy), `${lang}:${key} 命中违禁词 ${pattern} → ${copy}`).toBe(false);
        }
      }
    }
  });

  it('不把用户指向一个未必存在的 Wi-Fi——电脑挂手机热点时没有别的 Wi-Fi 可回', () => {
    // 可以说「不在同一个网络」（陈述现象），不可以说「回电脑的 Wi-Fi」（指派一个做不到的动作）。
    for (const key of keys) {
      expect(/回电脑的 ?Wi-?Fi|同一 ?Wi-?Fi/.test(zh[key]), `${key} → ${zh[key]}`).toBe(false);
      expect(/reconnect on .*Wi-?Fi|same Wi-?Fi/i.test(en[key]), `${key} → ${en[key]}`).toBe(false);
    }
  });

  it('两条「彻底连不上」的文案都给出重新扫码这条一定有效的出路', () => {
    for (const key of ['connectionRelayUnavailable', 'connectionRelayRejected'] as const) {
      expect(zh[key]).toContain('二维码');
      expect(en[key]).toMatch(/scan it/);
    }
  });
});
