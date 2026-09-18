import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { ensureAndroidVoiceForegroundService } from '../../../packages/mobile/scripts/configure-lan.mjs';

// JS↔原生合同（照 iosNativeVoicePlugin.test.ts / mdnsReconnect.test.ts 的先例）：Java 不在本仓
// 任何测试框架里，跨侧字符串错一个字桥就找不到实现；manifest 注入锚点漂移必须 fail-closed。
const buildAndroid = readFileSync('packages/mobile/scripts/build-android.mjs', 'utf8');
const configureLan = readFileSync('packages/mobile/scripts/configure-lan.mjs', 'utf8');
const capacitorPort = readFileSync('packages/mobile/src/platform/capacitor.ts', 'utf8');

describe('Android 录音前台服务（N-MOBILE-BG-RECORDING）三侧合同', () => {
  it('manifest：幂等注入 FOREGROUND_SERVICE(+MICROPHONE) 权限与 microphone 类型的 <service>', () => {
    const base = '<manifest><application></application></manifest>';
    const injected = ensureAndroidVoiceForegroundService(base);
    expect(injected).toContain('<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />');
    expect(injected).toContain('<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MICROPHONE" />');
    // 服务声明必须在 <application> 里，exported=false，类型是 microphone（Android 12+ 的硬要求）
    const serviceAt = injected.indexOf('<service android:name=".VoiceRecordingService"');
    expect(serviceAt).toBeGreaterThan(injected.indexOf('<application>'));
    expect(serviceAt).toBeLessThan(injected.indexOf('</application>'));
    expect(injected).toContain('android:exported="false" android:foregroundServiceType="microphone"');
    expect(ensureAndroidVoiceForegroundService(injected)).toBe(injected);
  });

  it('manifest 锚点（</application>）漂移时 fail-closed，不许静默漏注入', () => {
    expect(() => ensureAndroidVoiceForegroundService('<manifest></manifest>')).toThrow('ANDROID_MANIFEST_TEMPLATE_CHANGED');
  });

  it('生成：插件与服务写进工程，MainActivity 在 super.onCreate 前注册，服务用 microphone 前台类型', () => {
    expect(buildAndroid).toContain('VoiceKeepAlivePlugin.java');
    expect(buildAndroid).toContain('@CapacitorPlugin(name = "VoiceKeepAlive")');
    expect(buildAndroid).toContain('VoiceRecordingService.java');
    expect(buildAndroid).toContain('ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE');
    const register = buildAndroid.indexOf('registerPlugin(VoiceKeepAlivePlugin.class);');
    expect(register).toBeGreaterThan(-1);
    // registerPlugin 必须发生在 super.onCreate 之前：BridgeActivity 在自己的 onCreate 里就把 bridge 建完。
    expect(buildAndroid.indexOf('super.onCreate(savedInstanceState);', register)).toBeGreaterThan(register);
  });

  it('JS 侧：仅 android 注册桥；服务起在开录前、收在停录后（带防抖），通知文案走 i18n', () => {
    expect(capacitorPort).toContain("Capacitor.getPlatform() === 'android'");
    expect(capacitorPort).toContain("registerPlugin<VoiceKeepAliveBridge>('VoiceKeepAlive'");
    // 保活必须先于起录：服务没起来就切后台，第一段就断
    expect(capacitorPort).toMatch(/await keepAliveStart\(\);\s*\n\s*try \{\s*\n\s*await VoiceRecorder\.startRecording\(\);/);
    // 起录失败即这次录音到头：catch 里也要收服务，别等不存在的下一次 stop
    expect(capacitorPort).toMatch(/catch \(error\) \{\s*\n\s*keepAliveStop\(\);/);
    // stop 之后才收（分段录音每段都停开一次，防抖由 voiceServiceStopGraceMs 承担）
    expect(capacitorPort).toMatch(/await VoiceRecorder\.stopRecording\(\);\s*\n\s*keepAliveStop\(\);/);
    expect(capacitorPort).toContain('COMPANION_LIMITS.voiceServiceStopGraceMs');
    expect(capacitorPort).toContain('title: text.voice, text: text.voiceListening');
  });

  it('manifest 注入真接进 configureAndroidLan', () => {
    expect(configureLan).toContain('ensureAndroidVoiceForegroundService(xml)');
  });
});
