import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

import { ensureAndroidVoiceForegroundService } from '../../../packages/mobile/scripts/configure-lan.mjs';
import { COMPANION_LIMITS } from '../../../src/shared/constants/companion';

// JS↔原生合同（照 iosNativeVoicePlugin.test.ts / mdnsReconnect.test.ts 的先例）：Java 不在本仓
// 任何测试框架里，跨侧字符串错一个字桥就找不到实现；manifest 注入锚点漂移必须 fail-closed。
const buildAndroid = readFileSync('packages/mobile/scripts/build-android.mjs', 'utf8');
const configureLan = readFileSync('packages/mobile/scripts/configure-lan.mjs', 'utf8');
const capacitorPort = readFileSync('packages/mobile/src/platform/capacitor.ts', 'utf8');
const i18n = readFileSync('packages/mobile/src/i18n/index.ts', 'utf8');

// —— 运行时段的桩（vi.hoisted：vi.mock 工厂先于 import 求值，拿不到普通顶层 const）——
// capacitor 系包不在根 node_modules：mobile 依赖装好时（本机 tsc 需要）capacitor.ts 按真实路径
// 解析，mock 必须注册同一路径才拦得住；没装时（CI 只 npm ci 根仓）双方都退回裸说明符。
// 所以 core 与 voice-recorder 两个要控行为的包双注册，其余包裸注册（CI 侧必需，本机侧无害）。
const { stubs, coreFactory, recorderFactory } = vi.hoisted(() => {
  const stubs = {
    keepAliveStart: vi.fn(async () => {}),
    keepAliveStop: vi.fn(async () => {}),
    stopRecording: vi.fn(),
  };
  const coreFactory = () => ({
    Capacitor: { getPlatform: () => 'android', isNativePlatform: () => true },
    registerPlugin: () => ({ start: stubs.keepAliveStart, stop: stubs.keepAliveStop }),
    SystemBars: { setStyle: async () => {} },
    SystemBarsStyle: { Dark: 'Dark', Light: 'Light' },
  });
  const recorderFactory = () => ({
    VoiceRecorder: {
      requestAudioRecordingPermission: async () => ({ value: true }),
      startRecording: async () => {},
      stopRecording: (...args: unknown[]) => stubs.stopRecording(...args),
    },
  });
  return { stubs, coreFactory, recorderFactory };
});
// capacitor.ts 在模块加载时就按平台定型（android 才注册 VoiceKeepAlive 桥），桩必须给到 'android'。
vi.mock('@capacitor/core', coreFactory);
vi.mock('../../../packages/mobile/node_modules/@capacitor/core', coreFactory);
vi.mock('capacitor-voice-recorder', recorderFactory);
vi.mock('../../../packages/mobile/node_modules/capacitor-voice-recorder', recorderFactory);
vi.mock('@capacitor/app', () => ({ App: {} }));
vi.mock('@capacitor/camera', () => ({ Camera: {} }));
vi.mock('@capacitor/filesystem', () => ({ Directory: { Documents: 'Documents' }, Filesystem: {} }));
vi.mock('@capacitor/keyboard', () => ({ Keyboard: {} }));
vi.mock('@capacitor/preferences', () => ({ Preferences: { get: async () => ({ value: null }), set: async () => {} } }));
vi.mock('@capacitor/push-notifications', () => ({ PushNotifications: {} }));
vi.mock('../../../packages/mobile/src/platform/nativeCompanion', () => ({ nativeCompanionPort: {} }));

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

describe('Android 录音前台服务运行时（recorder 实例上真跑，PR#1944 ai-review 修复）', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('stopRecording reject 也回收前台服务（Important）：finally 兜底，防抖到期真停', async () => {
    stubs.stopRecording.mockRejectedValue(new Error('RECORDING_HAS_NOT_STARTED'));
    const { capacitorPorts } = await import('../../../packages/mobile/src/platform/capacitor');
    const recorder = capacitorPorts.recorder!;
    const stopsBefore = stubs.keepAliveStop.mock.calls.length;
    await expect(recorder.stop()).rejects.toThrow('RECORDING_HAS_NOT_STARTED');
    // 防抖窗口内还没真停——但回收已经排上，宽限一过必须落地
    expect(stubs.keepAliveStop.mock.calls.length).toBe(stopsBefore);
    await vi.advanceTimersByTimeAsync(COMPANION_LIMITS.voiceServiceStopGraceMs);
    expect(stubs.keepAliveStop.mock.calls.length).toBe(stopsBefore + 1);
  });

  it('一次录音只起一次服务：切段那声 start 不重复 startForegroundService，防抖内也不真停', async () => {
    stubs.stopRecording.mockResolvedValue({ value: { recordDataBase64: 'AAAA', mimeType: 'audio/aac', msDuration: 4000 } });
    const { capacitorPorts } = await import('../../../packages/mobile/src/platform/capacitor');
    const recorder = capacitorPorts.recorder!;
    const startsBefore = stubs.keepAliveStart.mock.calls.length;
    const stopsBefore = stubs.keepAliveStop.mock.calls.length;
    await recorder.start();   // ① 首段：真起服务
    await recorder.stop();    // 排防抖停
    await recorder.start();   // ② 切段：撤掉防抖停；running 已置位 → 不重复起
    expect(stubs.keepAliveStart.mock.calls.length).toBe(startsBefore + 1);
    expect(stubs.keepAliveStop.mock.calls.length).toBe(stopsBefore);   // 切段间隙服务没被真停
    await recorder.stop();    // 收尾：排防抖停，这次没有新 start 跟上
    await vi.advanceTimersByTimeAsync(COMPANION_LIMITS.voiceServiceStopGraceMs);
    expect(stubs.keepAliveStop.mock.calls.length).toBe(stopsBefore + 1);
    await recorder.start();   // 新一次录音：running 已随真停复位 → 重新起服务
    expect(stubs.keepAliveStart.mock.calls.length).toBe(startsBefore + 2);
  });

  it('EMPTY_RECORDING 分类语义不变：空段照抛、且同样排队回收', async () => {
    stubs.stopRecording.mockResolvedValue({ value: { recordDataBase64: undefined, mimeType: 'audio/aac', msDuration: 0 } });
    const { capacitorPorts } = await import('../../../packages/mobile/src/platform/capacitor');
    const recorder = capacitorPorts.recorder!;
    const stopsBefore = stubs.keepAliveStop.mock.calls.length;
    await expect(recorder.stop()).rejects.toThrow('EMPTY_RECORDING');
    await vi.advanceTimersByTimeAsync(COMPANION_LIMITS.voiceServiceStopGraceMs);
    expect(stubs.keepAliveStop.mock.calls.length).toBe(stopsBefore + 1);
  });
});
