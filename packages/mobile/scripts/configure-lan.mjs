import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

export function ensureAndroidPushPermission(xml) {
  if (xml.includes('android.permission.POST_NOTIFICATIONS')) return xml;
  return xml.replace('</manifest>', '<uses-permission android:name="android.permission.POST_NOTIFICATIONS" /></manifest>');
}

/**
 * fix4-⑤：mDNS 单次解析要能收组播包（224.0.0.251:5353）。没有
 * CHANGE_WIFI_MULTICAST_STATE 时 MulticastLock.acquire() 直接抛 SecurityException，
 * 多数 Wi-Fi 驱动还会把组播包整包滤掉——解析永远等不到应答。
 */
export function ensureAndroidMulticastPermission(xml) {
  if (xml.includes('android.permission.CHANGE_WIFI_MULTICAST_STATE')) return xml;
  return xml.replace('</manifest>', '<uses-permission android:name="android.permission.CHANGE_WIFI_MULTICAST_STATE" /></manifest>');
}

export function ensureAndroidCameraPermission(xml) {
  if (xml.includes('android.permission.CAMERA')) return xml;
  return xml.replace('</manifest>', '<uses-permission android:name="android.permission.CAMERA" /></manifest>');
}

/**
 * N-MOBILE-BG-RECORDING：Android 12+ 后台用麦克风必须有 microphone 类型的前台服务，
 * 否则系统直接静音/断麦。服务本体由 build-android.mjs 生成（VoiceRecordingService.java），
 * 这里幂等注入它需要的权限与 <service> 声明。Android 14 的 FOREGROUND_SERVICE_MICROPHONE
 * 是普通权限，声明即授予。
 */
export function ensureAndroidVoiceForegroundService(xml) {
  let out = xml;
  // 判据带结尾引号：不带的话 FOREGROUND_SERVICE 会把 FOREGROUND_SERVICE_MICROPHONE 也算作已注入。
  if (!out.includes('android.permission.FOREGROUND_SERVICE"')) {
    out = out.replace('</manifest>', '<uses-permission android:name="android.permission.FOREGROUND_SERVICE" /></manifest>');
  }
  if (!out.includes('android.permission.FOREGROUND_SERVICE_MICROPHONE"')) {
    out = out.replace('</manifest>', '<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MICROPHONE" /></manifest>');
  }
  if (!out.includes('VoiceRecordingService')) {
    if (!out.includes('</application>')) throw new Error('ANDROID_MANIFEST_TEMPLATE_CHANGED');
    out = out.replace('</application>',
      '<service android:name=".VoiceRecordingService" android:exported="false" android:foregroundServiceType="microphone" /></application>');
  }
  return out;
}

export function mergeRemoteNotificationMode(modes) {
  const list = Array.isArray(modes) ? modes.filter(mode => typeof mode === 'string' && mode.length > 0) : [];
  if (!list.includes('remote-notification')) list.push('remote-notification');
  return list;
}

/**
 * N-MOBILE-BG-RECORDING（爸 2026-09-18 拍板，翻掉「麦克风不该在用户看不见的时候开着」）：
 * 录音中切后台要继续录。没有 audio 后台模式，进程一进后台就被挂起——录音/切段/队列泵全停。
 * 与 mergeRemoteNotificationMode 同款幂等 merge：plist 里已有的模式（含手写的）不动，缺的补上。
 */
export function mergeVoiceBackgroundMode(modes) {
  const list = mergeRemoteNotificationMode(modes);
  if (!list.includes('audio')) list.push('audio');
  return list;
}

function readBackgroundModes(plist) {
  try {
    return execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :UIBackgroundModes', plist], { encoding: 'utf8' })
      .split('\n').map(line => line.trim()).filter(line => line && line !== 'Array {' && line !== '}');
  } catch {
    return [];
  }
}

export function configureIosLan() {
  const plist = 'ios/App/App/Info.plist';
  const set = (key, type, value) => {
    try { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Delete :${key}`, plist], { stdio: 'ignore' }); } catch {}
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} ${type} ${value}`, plist]);
  };
  set('NSMicrophoneUsageDescription', 'string', 'Record speech and transcribe it through your computer into an editable draft.');
  set('NSCameraUsageDescription', 'string', 'Scan the pairing code shown by Neo on your computer, or photograph materials you want to send.');
  set('NSLocalNetworkUsageDescription', 'string', 'Connect to your computer to send tasks and receive results in Neo.');
  const modes = mergeVoiceBackgroundMode(readBackgroundModes(plist));
  try { execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Delete :UIBackgroundModes', plist], { stdio: 'ignore' }); } catch {}
  execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Add :UIBackgroundModes array', plist]);
  modes.forEach((mode, index) => {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :UIBackgroundModes:${index} string ${mode}`, plist]);
  });
  try { execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Add :NSAppTransportSecurity dict', plist], { stdio: 'ignore' }); } catch {}
  set('NSAppTransportSecurity:NSAllowsLocalNetworking', 'bool', 'true');
  // iOS 17+ also requires IP/CIDR ATS exceptions for numeric LAN endpoints.
  const exceptions = 'NSAppTransportSecurity:NSExceptionDomains';
  try { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${exceptions} dict`, plist], { stdio: 'ignore' }); } catch {}
  for (const range of ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']) {
    try { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${exceptions}:${range} dict`, plist], { stdio: 'ignore' }); } catch {}
    set(`${exceptions}:${range}:NSExceptionAllowsInsecureHTTPLoads`, 'bool', 'true');
  }
}

export function configureAndroidLan() {
  const manifest = 'android/app/src/main/AndroidManifest.xml';
  let xml = readFileSync(manifest, 'utf8');
  // Native HTTP carries Noise records to validated RFC1918 addresses. WebView mixed content stays disabled.
  if (/android:usesCleartextTraffic=/.test(xml)) xml = xml.replace(/android:usesCleartextTraffic="[^"]*"/, 'android:usesCleartextTraffic="true"');
  else xml = xml.replace('<application', '<application android:usesCleartextTraffic="true"');
  xml = ensureAndroidCameraPermission(xml);
  if (!xml.includes('android.permission.RECORD_AUDIO')) xml = xml.replace('</manifest>', '<uses-permission android:name="android.permission.RECORD_AUDIO" /></manifest>');
  xml = ensureAndroidPushPermission(xml);
  xml = ensureAndroidMulticastPermission(xml);
  xml = ensureAndroidVoiceForegroundService(xml);
  // Do not restore an Android Keystore ciphertext onto a different installation.
  if (/android:allowBackup=/.test(xml)) xml = xml.replace(/android:allowBackup="[^"]*"/, 'android:allowBackup="false"');
  else xml = xml.replace('<application', '<application android:allowBackup="false"');
  writeFileSync(manifest, xml);
  const variables = 'android/variables.gradle';
  const gradle = readFileSync(variables, 'utf8');
  writeFileSync(variables, gradle.replace(/minSdkVersion\s*=\s*(\d+)/, (_match, value) => `minSdkVersion = ${Math.max(26, Number(value))}`));
}

if (process.argv.includes('--ios')) configureIosLan();
if (process.argv.includes('--android')) configureAndroidLan();
