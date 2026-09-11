import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

export function ensureAndroidPushPermission(xml) {
  if (xml.includes('android.permission.POST_NOTIFICATIONS')) return xml;
  return xml.replace('</manifest>', '<uses-permission android:name="android.permission.POST_NOTIFICATIONS" /></manifest>');
}

export function configureIosLan() {
  const plist = 'ios/App/App/Info.plist';
  const set = (key, type, value) => {
    try { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Delete :${key}`, plist], { stdio: 'ignore' }); } catch {}
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} ${type} ${value}`, plist]);
  };
  set('NSMicrophoneUsageDescription', 'string', 'Record speech and transcribe it through your computer into an editable draft.');
  set('NSCameraUsageDescription', 'string', 'Scan the pairing code shown by Neo on your computer.');
  set('NSLocalNetworkUsageDescription', 'string', 'Connect to your computer to send tasks and receive results in Neo.');
  try { execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Delete :UIBackgroundModes', plist], { stdio: 'ignore' }); } catch {}
  execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Add :UIBackgroundModes array', plist]);
  execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Add :UIBackgroundModes:0 string remote-notification', plist]);
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
  if (!xml.includes('android.permission.CAMERA')) xml = xml.replace('</manifest>', '<uses-permission android:name="android.permission.CAMERA" /></manifest>');
  if (!xml.includes('android.permission.RECORD_AUDIO')) xml = xml.replace('</manifest>', '<uses-permission android:name="android.permission.RECORD_AUDIO" /></manifest>');
  xml = ensureAndroidPushPermission(xml);
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
