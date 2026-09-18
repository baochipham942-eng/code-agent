import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { ensureAndroidVoiceForegroundService } from '../../../packages/mobile/scripts/configure-lan.mjs';

// JS↔原生合同（照 iosNativeVoicePlugin.test.ts / mdnsReconnect.test.ts 的先例）：Java 不在本仓
// 任何测试框架里，跨侧字符串错一个字桥就找不到实现；manifest 注入锚点漂移必须 fail-closed。
const buildAndroid = readFileSync('packages/mobile/scripts/build-android.mjs', 'utf8');
const configureLan = readFileSync('packages/mobile/scripts/configure-lan.mjs', 'utf8');
const capacitorPort = readFileSync('packages/mobile/src/platform/capacitor.ts', 'utf8');
const i18n = readFileSync('packages/mobile/src/i18n/index.ts', 'utf8');

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

  it('生成：通知通道名走 JS 的 i18n（插件 start 建/更通道），服务 onCreate 只留英文兜底', () => {
    expect(buildAndroid).toContain('call.getString("channelName", "Recording")');
    expect(buildAndroid).toContain('manager.createNotificationChannel(new NotificationChannel(');
    // 兜底仍在服务侧：插件没先建过（理论上不会）也不许裸 Builder 挂不存在的通道
    expect(buildAndroid).toContain('if (manager.getNotificationChannel(VoiceKeepAlivePlugin.CHANNEL_ID) == null)');
  });

  it('生成：通知小图标是 Neo 自有资源（品牌字形 vector drawable 随构建写入），不用系统通用图标', () => {
    // PR#1944 ai-review Nit：sym_def_app_icon 是系统通用占位图标，常驻通知必须用自家资源
    expect(buildAndroid).toContain('.setSmallIcon(R.drawable.neo_recording_icon)');
    expect(buildAndroid).not.toContain('android.R.drawable.sym_def_app_icon');
    expect(buildAndroid).toContain("writeFileSync('android/app/src/main/res/drawable/neo_recording_icon.xml'");
  });

  it('JS 侧：仅 android 注册桥；服务起在开录前、收在停录后（带防抖），通知文案走 i18n', () => {
    expect(capacitorPort).toContain("Capacitor.getPlatform() === 'android'");
    expect(capacitorPort).toContain("registerPlugin<VoiceKeepAliveBridge>('VoiceKeepAlive'");
    // 保活必须先于起录：服务没起来就切后台，第一段就断
    expect(capacitorPort).toMatch(/await keepAliveStart\(\);\s*\n\s*try \{\s*\n\s*await VoiceRecorder\.startRecording\(\);/);
    // 起录失败即这次录音到头了：catch 里也要收服务，别等不存在的下一次 stop
    expect(capacitorPort).toMatch(/catch \(error\) \{\s*\n\s*keepAliveStop\(\);/);
    // stop 的任何结局都要收服务（PR#1944 ai-review Important）：stopRecording reject 时调用方已把
    // live 落 false、不会再补一次 stop，keepAliveStop 必须兜在 finally，否则常驻通知永久留在通知栏。
    expect(capacitorPort).toMatch(/const \{ value \} = await VoiceRecorder\.stopRecording\(\);[\s\S]*?\} finally \{\s*\n\s*keepAliveStop\(\);/);
    expect(capacitorPort).toContain('COMPANION_LIMITS.voiceServiceStopGraceMs');
    // 一次录音只起一次服务：切段那声 start 被 running 标记挡掉（ai-review Nit）
    expect(capacitorPort).toMatch(/if \(running\) return;/);
    // 常驻通知标题是专门的「正在录音」，不复用麦克风按钮的「语音输入」（ai-review Nit）；通道名同走 i18n
    expect(capacitorPort).toContain('title: text.voiceRecording, text: text.voiceListening, channelName: text.voiceRecordingChannel');
    expect(capacitorPort).not.toContain('title: text.voice,');
    expect(i18n).toContain("voiceRecording: '正在录音', voiceRecordingChannel: '录音'");
    expect(i18n).toContain("voiceRecording: 'Recording', voiceRecordingChannel: 'Recording'");
  });

  it('manifest 注入真接进 configureAndroidLan', () => {
    expect(configureLan).toContain('ensureAndroidVoiceForegroundService(xml)');
  });
});

// 运行时段改源码契约（N-MOBILE-BG-RECORDING-R4）：capacitor 系包只活在 packages/mobile 独立锁，
// 根测试程序（tsconfig.tests.json + 根 npm ci）里 import capacitor.ts 会把它连同不可解析的
// capacitor 依赖一起拽进 tsc 程序（15 处 TS2307/implicit any）。照 nativeCompanionExchange.test.ts
// 的先例改为钉住 nativeRecorder 里的代码事实——原 vitest 桩跑的三条行为（stop reject 回收 /
// 一次录音一起服务 / EMPTY_RECORDING 照抛）所依赖的符号与调用序一点不少。
describe('Android 录音前台服务运行时（源码契约：recorder 起停/防抖/复位，PR#1944 ai-review 修复）', () => {
  it('stopRecording reject 也回收前台服务（Important）：finally 兜底，真停排队到期才落地', () => {
    // try 直接收 finally（无 catch）：stopRecording 的任何结局——含 reject 原样上抛给调用方
    // （VoiceCapture.run 已把 live 落 false、不会补 stop）——回收都已排上
    expect(capacitorPort).toMatch(/const \{ value \} = await VoiceRecorder\.stopRecording\(\);[\s\S]*?\} finally \{\s*\n\s*keepAliveStop\(\);/);
    // 真停不是即时的：防抖排在 setTimeout 回调里，宽限取共享常量，到期才调服务的 stop
    expect(capacitorPort).toContain('stopTimer = setTimeout(() => {');
    expect(capacitorPort).toContain('void voiceKeepAlive.stop()');
    expect(capacitorPort).toMatch(/void voiceKeepAlive\.stop\(\)[\s\S]{0,120}\}, COMPANION_LIMITS\.voiceServiceStopGraceMs\);/);
  });

  it('一次录音只起一次服务：切段 start 撤防抖停、running 置位不重复起、真停才复位', () => {
    // 切段那声 start 先撤掉挂着的防抖停：切段间隙服务没被真停，通知不闪
    expect(capacitorPort).toMatch(/if \(stopTimer\) \{ clearTimeout\(stopTimer\); stopTimer = null; \}/);
    // running 已置位 → 不重复 startForegroundService
    expect(capacitorPort).toMatch(/if \(running\) return;/);
    // 复位只发生在真停回调里：下次录音的 start 不再被挡，重新起服务
    expect(capacitorPort).toMatch(/stopTimer = setTimeout\(\(\) => \{\s*\n\s*stopTimer = null;\s*\n\s*running = false;/);
    // 起服务成功才置 running：start 失败（fail-open 只 warn）不算在跑
    expect(capacitorPort).toMatch(/await voiceKeepAlive\.start\(\{ title: text\.voiceRecording[\s\S]*?\}\);\s*\n\s*running = true;/);
  });

  it('EMPTY_RECORDING 分类语义不变：空段照抛，且抛出点与回收同在一个 try/finally', () => {
    expect(capacitorPort).toContain("if (!value.recordDataBase64) throw new Error('EMPTY_RECORDING');");
    // 抛出点在 stopRecording 与 finally 之间：空段既向上抛、又照样触发排队回收
    const stopCall = capacitorPort.indexOf('const { value } = await VoiceRecorder.stopRecording();');
    const emptyThrow = capacitorPort.indexOf("if (!value.recordDataBase64) throw new Error('EMPTY_RECORDING');");
    const finallyKw = capacitorPort.indexOf('} finally {', stopCall);
    expect(emptyThrow).toBeGreaterThan(stopCall);
    expect(emptyThrow).toBeLessThan(finallyKw);
  });
});
