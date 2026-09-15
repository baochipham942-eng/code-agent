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
    expect(text.connectionUnavailable).toContain('睡眠');
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
