import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  appEntitlementsXml, assertBinaryPushEntitlement, assertPushEntitlement, ensureAppPushEntitlements,
  exportOptionsXml, extractNativeTargetId, extractPlistXml, parseEntitlementsDump, parsePlistXml, patchPbxprojVersions,
  profileCoversDevice, readMobileprovision, summarizeProfile, unlinkedSpmPlugins, withApsEnvironment,
  withCodeSignEntitlements, withPushAppDelegateHooks, withSelfImplementedPluginClasses,
} from '../../../packages/mobile/scripts/ios-package.mjs';
import { ensureAndroidPushPermission, mergeRemoteNotificationMode } from '../../../packages/mobile/scripts/configure-lan.mjs';

const profileXml = ({ taskAllow, devices, expires, aps }: { taskAllow?: boolean; devices?: string[]; expires: string; aps?: string | null }) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Name</key><string>Neo Preview AdHoc</string>
  <key>UUID</key><string>AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE</string>
  <key>TeamName</key><string>Neo Preview Team</string>
  <key>TeamIdentifier</key>
  <array><string>D7CVTJ72NV</string></array>
  <key>CreationDate</key><date>2026-09-01T08:00:00Z</date>
  <key>ExpirationDate</key><date>${expires}</date>
  ${devices === undefined ? '' : `<key>ProvisionedDevices</key>
  <array>${devices.map(device => `<string>${device}</string>`).join('')}</array>`}
  <key>Entitlements</key>
  <dict>
    <key>application-identifier</key><string>D7CVTJ72NV.dev.neo.companion.preview</string>
    ${aps === null ? '' : `<key>aps-environment</key><string>${aps ?? 'production'}</string>`}
    <key>get-task-allow</key><${taskAllow ?? false}/>
  </dict>
</dict>
</plist>`;

const asProfileBuffer = (xml: string) => Buffer.concat([Buffer.from([0x30, 0x82, 0x0c, 0x51, 0x02, 0x01]), Buffer.from(xml, 'latin1')]);
const targetUdid = '00008101-0000000000000001';

describe('mobileprovision parsing and classification', () => {
  it('extracts and parses the embedded plist from DER-wrapped profile bytes', () => {
    const plist = readMobileprovision(asProfileBuffer(profileXml({ devices: [targetUdid], expires: '2027-01-01T00:00:00Z' })));
    expect(plist).toMatchObject({ Name: 'Neo Preview AdHoc', UUID: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE' });
    expect(plist.CreationDate).toEqual(new Date('2026-09-01T08:00:00Z'));
  });
  it('throws instead of guessing when the profile has no plist payload', () => {
    expect(() => extractPlistXml(Buffer.from('garbage-without-plist'))).toThrow('MOBILEPROVISION_PLIST_MISSING');
  });
  it('writes pairing identity with whenUnlockedThisDeviceOnly and does not fall back to Preferences', () => {
    const source = readFileSync('packages/mobile/src/platform/nativeCompanion.ts', 'utf8');
    expect(source).toContain('KeychainAccess.whenUnlockedThisDeviceOnly');
    expect(source).toContain('SecureStorage.set');
    expect(source).not.toMatch(/Preferences\.set\(\{\s*key:\s*STATE_KEY/);
    expect(source).toContain('Sign to Run Locally');
    expect(source).toContain('TeamIdentifier');
  });

  it('signed Ad Hoc profiles carry TeamIdentifier; empty team is the simulator Sign to Run Locally shape', () => {
    const signed = summarizeProfile(readMobileprovision(asProfileBuffer(profileXml({ devices: [targetUdid], expires: '2027-01-01T00:00:00Z' }))));
    expect(signed.teamIdentifier).toEqual(['D7CVTJ72NV']);
    expect(signed.method).toBe('ad-hoc');
    const unsigned = summarizeProfile({ TeamIdentifier: [] });
    expect(unsigned.teamIdentifier).toEqual([]);
  });

  it('classifies ad-hoc (devices, no debugging) versus development (devices, debugging) versus app-store (no devices)', () => {
    expect(summarizeProfile(readMobileprovision(asProfileBuffer(profileXml({ devices: [targetUdid], expires: '2027-01-01T00:00:00Z' })))).method).toBe('ad-hoc');
    expect(summarizeProfile(readMobileprovision(asProfileBuffer(profileXml({ taskAllow: true, devices: [targetUdid], expires: '2027-01-01T00:00:00Z' })))).method).toBe('development');
    expect(summarizeProfile(readMobileprovision(asProfileBuffer(profileXml({ expires: '2027-01-01T00:00:00Z' })))).method).toBe('app-store');
  });
  it('flags expiry against a caller-provided clock and reports the ad-hoc device coverage separately', () => {
    const plist = readMobileprovision(asProfileBuffer(profileXml({ devices: [targetUdid], expires: '2026-10-01T00:00:00Z' })));
    const summary = summarizeProfile(plist, new Date('2026-09-08T00:00:00Z'));
    expect(summary.expired).toBe(false);
    expect(summarizeProfile(plist, new Date('2026-10-02T00:00:00Z')).expired).toBe(true);
    expect(summary.provisionedDeviceCount).toBe(1);
    expect(profileCoversDevice(plist, targetUdid)).toBe(true);
    expect(profileCoversDevice(plist, 'aabbcc-unknown')).toBe(false);
  });
  it('fails closed when the profile has no Push entitlement instead of reporting a silent empty field', () => {
    const summary = summarizeProfile(readMobileprovision(asProfileBuffer(profileXml({ devices: [targetUdid], expires: '2027-01-01T00:00:00Z', aps: null }))));
    expect(summary.apsEnvironment).toBeNull();
    expect(() => assertPushEntitlement(summary)).toThrow('PUSH_ENTITLEMENT_MISSING');
    expect(assertPushEntitlement(summarizeProfile(readMobileprovision(asProfileBuffer(profileXml({ devices: [targetUdid], expires: '2027-01-01T00:00:00Z' }))))))
      .toBe('production');
  });
});

describe('android push permission declaration', () => {
  it('adds POST_NOTIFICATIONS once and does not invent an FCM channel', () => {
    const xml = ensureAndroidPushPermission('<manifest><application /></manifest>');
    expect(xml).toContain('android.permission.POST_NOTIFICATIONS');
    expect(ensureAndroidPushPermission(xml)).toBe(xml);
  });
});

describe('iOS background modes merge', () => {
  it('keeps existing modes such as audio and only appends remote-notification', () => {
    expect(mergeRemoteNotificationMode(['audio'])).toEqual(['audio', 'remote-notification']);
    expect(mergeRemoteNotificationMode(['remote-notification'])).toEqual(['remote-notification']);
    expect(mergeRemoteNotificationMode([])).toEqual(['remote-notification']);
  });
});

describe('project version stamping', () => {
  const pbxproj = (version: string, build: number) => `/* Begin XCBuildConfiguration section */
		504EC31E1FED79650016851F /* Release */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				CURRENT_PROJECT_VERSION = ${build};
				MARKETING_VERSION = ${version};
				PRODUCT_BUNDLE_IDENTIFIER = dev.neo.companion.preview;
			};
		};
		504EC31F1FED79650016851F /* Debug */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				CURRENT_PROJECT_VERSION = ${build};
				MARKETING_VERSION = ${version};
			};
		};
/* End XCBuildConfiguration section */`;
  it('stamps every configuration with the requested version and build number', () => {
    expect(patchPbxprojVersions(pbxproj('1.0', 1), '0.1.0', 4))
      .toBe(pbxproj('0.1.0', 4));
  });
  it('refuses to patch an unrecognized template instead of building unversioned', () => {
    expect(() => patchPbxprojVersions('no version fields here', '0.1.0', 4)).toThrow('IOS_TEMPLATE_CHANGED');
    expect(() => extractNativeTargetId('no native target here')).toThrow('IOS_TEMPLATE_CHANGED');
  });
  it('reads the App native target id for the shared scheme', () => {
    expect(extractNativeTargetId('/* Begin PBXNativeTarget section */\n\t\t504EC3031FED79650016851F /* App */ = {\n\t\t\t\tisa = PBXNativeTarget;\n\t\t\t\tname = App;')).toBe('504EC3031FED79650016851F');
  });
});

describe('ad-hoc export options', () => {
  it('renders manual signing with the explicit profile and boolean plist literals', () => {
    const xml = exportOptionsXml({ method: 'ad-hoc', teamId: 'D7CVTJ72NV', style: 'manual', appId: 'dev.neo.companion.preview', profileName: 'Neo Preview AdHoc', identity: 'iPhone Distribution: Neo Preview Team (D7CVTJ72NV)' });
    expect(exportOptionsXml({ method: 'ad-hoc', teamId: 'D7CVTJ72NV', style: 'manual', appId: 'dev.neo.companion.preview', profileName: 'A & B <C>', identity: 'iPhone Distribution: Neo Preview Team (D7CVTJ72NV)' }))
      .toContain('<string>A &amp; B &lt;C&gt;</string>');
    expect(xml).toContain('<key>method</key><string>ad-hoc</string>');
    expect(xml).toContain('<key>signingStyle</key><string>manual</string>');
    expect(xml).toContain('<key>provisioningProfiles</key><dict><key>dev.neo.companion.preview</key><string>Neo Preview AdHoc</string></dict>');
    expect(xml).toContain('<key>compileBitcode</key><false/>');
    expect(xml).toContain('<key>stripSwiftSymbols</key><true/>');
  });
  it('automatic signing omits the manual profile block', () => {
    const xml = exportOptionsXml({ method: 'ad-hoc', teamId: 'D7CVTJ72NV', style: 'automatic', appId: 'dev.neo.companion.preview', profileName: null, identity: null });
    expect(xml).toContain('<key>signingStyle</key><string>automatic</string>');
    expect(xml).not.toContain('provisioningProfiles');
  });
});

describe('plist parser primitives', () => {
  it('parses nested containers, integers and booleans', () => {
    expect(parsePlistXml('<plist version="1.0"><dict><key>n</key><integer>42</integer><key>ok</key><true/><key>list</key><array><string>a</string><false/></array><key>certs</key><array><data>QUJD</data></array></dict></plist>'))
      .toEqual({ n: 42, ok: true, list: ['a', false], certs: ['QUJD'] });
  });
  it('rejects truncated input with a position, not a wrong answer', () => {
    expect(() => parsePlistXml('<plist version="1.0"><dict><key>k</key><string>unterminated')).toThrow(/PLIST_UNTERMINATED_STRING/);
  });
});

describe('SPM plugin linkage', () => {
  // cap sync 写出来的真实形状：每个链进去的插件一行 .package(name:…, path: "../../../node_modules/<包名>")
  const packageSwift = `// swift-tools-version: 5.9
let package = Package(
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.5.1"),
        .package(name: "CapacitorApp", path: "../../../node_modules/@capacitor/app"),
        .package(name: "CapacitorKeyboard", path: "../../../node_modules/@capacitor/keyboard")
    ]
)`;

  it('names the plugin cap sync silently dropped for having no Package.swift', () => {
    expect(unlinkedSpmPlugins(packageSwift, ['@capacitor/app', '@capacitor/keyboard', 'capacitor-voice-recorder']))
      .toEqual(['capacitor-voice-recorder']);
  });

  it('does not flag a plugin we implement natively ourselves', () => {
    expect(unlinkedSpmPlugins(packageSwift, ['@capacitor/app', 'capacitor-voice-recorder'], ['capacitor-voice-recorder']))
      .toEqual([]);
  });

  it('matches the whole package name, not a prefix of a longer entry', () => {
    // 只链了 app-launcher，没链 app。子串匹配会在 ".../node_modules/@capacitor/app-launcher" 里
    // 找到 "@capacitor/app"，把没链的那个误判成已链接——那正是这道闸要防的静默放行。
    const onlyLauncher = `.package(name: "CapacitorAppLauncher", path: "../../../node_modules/@capacitor/app-launcher")`;
    expect(unlinkedSpmPlugins(onlyLauncher, ['@capacitor/app'])).toEqual(['@capacitor/app']);
    expect(unlinkedSpmPlugins(onlyLauncher, ['@capacitor/app-launcher'])).toEqual([]);
  });

  it('reports every unlinked plugin, not just the first', () => {
    expect(unlinkedSpmPlugins(packageSwift, ['capacitor-voice-recorder', '@capacitor/filesystem']))
      .toEqual(['capacitor-voice-recorder', '@capacitor/filesystem']);
  });

  it('fails closed when Package.swift omitted @capacitor/push-notifications', () => {
    expect(unlinkedSpmPlugins(packageSwift, ['@capacitor/app', '@capacitor/push-notifications']))
      .toEqual(['@capacitor/push-notifications']);
  });
});

describe('iOS AppDelegate and entitlements for APNs', () => {
  const appDelegate = `import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        return true
    }
}
`;

  it('forwards APNs token and registration failure onto Capacitor notifications', () => {
    const patched = withPushAppDelegateHooks(appDelegate);
    expect(patched).toContain('capacitorDidRegisterForRemoteNotifications');
    expect(patched).toContain('capacitorDidFailToRegisterForRemoteNotifications');
    expect(withPushAppDelegateHooks(patched)).toBe(patched);
  });

  it('fails closed when AppDelegate is not the Capacitor class', () => {
    expect(() => withPushAppDelegateHooks('class SomethingElse {}')).toThrow('IOS_APP_DELEGATE_MISSING');
  });

  it('writes aps-environment instead of leaving the entitlements dict empty', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
</dict>
</plist>`;
    expect(withApsEnvironment(xml, 'production')).toContain('<string>production</string>');
    expect(withApsEnvironment(withApsEnvironment(xml, 'production'), 'development')).toContain('<string>development</string>');
    expect(() => withApsEnvironment('<plist></plist>', 'production')).toThrow('IOS_ENTITLEMENTS_UNPATCHABLE');
  });
});

const appPbxproj = `/* Begin XCBuildConfiguration section */
		504EC31E1FED79650016851F /* Release */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				PRODUCT_BUNDLE_IDENTIFIER = dev.neo.companion.preview;
				MARKETING_VERSION = 0.1.0;
			};
		};
		504EC31F1FED79650016851F /* Debug */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				PRODUCT_BUNDLE_IDENTIFIER = dev.neo.companion.preview;
				MARKETING_VERSION = 0.1.0;
			};
		};
		504EC31D1FED79650016851F /* Project Release */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				SDKROOT = iphoneos;
			};
		};
/* End XCBuildConfiguration section */`;

describe('App target push entitlements wiring', () => {
  it('creates an entitlements plist and wires CODE_SIGN_ENTITLEMENTS when the file is missing', () => {
    const first = ensureAppPushEntitlements({
      existingXml: null,
      pbxproj: appPbxproj,
      environment: 'production',
      appId: 'dev.neo.companion.preview',
    });
    expect(first.entitlementsXml).toBe(appEntitlementsXml('production'));
    expect(first.entitlementsXml).toContain('<key>aps-environment</key>');
    expect(first.entitlementsXml).toContain('<string>production</string>');
    expect(first.pbxproj).toContain('CODE_SIGN_ENTITLEMENTS = App/App.entitlements;');
    expect(first.pbxproj.match(/CODE_SIGN_ENTITLEMENTS = App\/App.entitlements;/g)).toHaveLength(2);
    expect(first.pbxproj).toMatch(/SDKROOT = iphoneos;\n\t\t\t\}/);
    const second = ensureAppPushEntitlements({
      existingXml: first.entitlementsXml,
      pbxproj: first.pbxproj,
      environment: 'production',
      appId: 'dev.neo.companion.preview',
    });
    expect(second).toEqual(first);
  });

  it('follows the profile development value instead of always writing production', () => {
    const xml = ensureAppPushEntitlements({
      existingXml: null,
      pbxproj: appPbxproj,
      environment: 'development',
      appId: 'dev.neo.companion.preview',
    }).entitlementsXml;
    expect(xml).toContain('<string>development</string>');
    expect(withApsEnvironment(xml, 'development')).toBe(xml);
  });

  it('refuses to patch an unrecognized App target layout instead of signing without entitlements', () => {
    expect(() => withCodeSignEntitlements('no build settings', {
      relativePath: 'App/App.entitlements',
      appId: 'dev.neo.companion.preview',
    })).toThrow('IOS_APP_ENTITLEMENTS_CONFIGURATIONS_CHANGED');
    expect(() => withCodeSignEntitlements(appPbxproj, {
      relativePath: '../Other.entitlements',
      appId: 'dev.neo.companion.preview',
    })).toThrow('IOS_ENTITLEMENTS_PATH_INVALID');
  });
});

describe('signed binary aps-environment', () => {
  const emptyDump = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
</dict>
</plist>
`;
  const codesignDump = `Executable=/tmp/Payload/App.app/App
${appEntitlementsXml('production')}`;

  it('fails closed when the binary entitlements omit aps-environment', () => {
    expect(parseEntitlementsDump(emptyDump).apsEnvironment).toBeNull();
    expect(() => assertBinaryPushEntitlement(emptyDump)).toThrow('IOS_BINARY_APS_ENVIRONMENT_MISSING');
    expect(() => assertBinaryPushEntitlement('codesign: no entitlements')).toThrow('IOS_BINARY_ENTITLEMENTS_UNREADABLE');
  });

  it('accepts production or development from a codesign --entitlements dump', () => {
    expect(assertBinaryPushEntitlement(codesignDump)).toBe('production');
    expect(assertBinaryPushEntitlement(appEntitlementsXml('development'))).toBe('development');
  });
});

describe('iOS build and verify scripts fail closed on missing binary aps-environment', () => {
  const buildScript = readFileSync('packages/mobile/scripts/build-ios.mjs', 'utf8');
  const verifyScript = readFileSync('packages/mobile/scripts/ios-verify.mjs', 'utf8');

  it('always writes entitlements and CODE_SIGN_ENTITLEMENTS, then inspects the signed binary', () => {
    expect(buildScript).toContain('ensureAppPushEntitlements');
    expect(buildScript).toContain('assertBinaryPushEntitlement');
    expect(buildScript).toContain('IOS_CODE_SIGN_ENTITLEMENTS_NOT_WIRED');
    expect(buildScript).toContain("['-d', '--entitlements', ':-'");
    expect(buildScript).not.toMatch(/if \(existsSync\(entitlements\)\) \{/);
  });

  it('adds a binary entitlements check without dropping the profile check', () => {
    expect(verifyScript).toContain("check('binary-aps-environment-present'");
    expect(verifyScript).toContain('assertBinaryPushEntitlement');
    expect(verifyScript).toContain("check('push-entitlement-present'");
    expect(verifyScript).toContain("['-d', '--entitlements', ':-'");
  });
});

describe('capacitor plugin registration list', () => {
  // cap sync 生成的真实形状：厂商插件的 ObjC 类名照样进表，哪怕那个包没被链接。
  const config = { appId: 'dev.neo.companion.preview', packageClassList: ['AppPlugin', 'KeyboardPlugin', 'VoiceRecorder'] };
  const replacements = [{ vendorClass: 'VoiceRecorder', nativeClass: 'NeoVoiceRecorderPlugin' }];

  it('swaps the vendor class for the first-party one in place', () => {
    expect(withSelfImplementedPluginClasses(config, replacements).packageClassList)
      .toEqual(['AppPlugin', 'KeyboardPlugin', 'NeoVoiceRecorderPlugin']);
  });

  it('registers the first-party class even when cap sync never listed the vendor one', () => {
    // 厂商 npm 依赖若被移除，cap sync 不会再写 VoiceRecorder——那时仍必须登记我们自己的类，
    // 否则录音会再次静默失效。
    expect(withSelfImplementedPluginClasses({ packageClassList: ['AppPlugin'] }, replacements).packageClassList)
      .toEqual(['AppPlugin', 'NeoVoiceRecorderPlugin']);
  });

  it('does not duplicate an already registered class', () => {
    const once = withSelfImplementedPluginClasses(config, replacements);
    expect(withSelfImplementedPluginClasses(once, replacements).packageClassList)
      .toEqual(once.packageClassList);
  });

  it('refuses to rewrite a config whose class list is missing or malformed', () => {
    // 静默当成空表 = 其余插件的登记被一起丢掉，那是整包功能级的静默损坏
    for (const broken of [{}, { packageClassList: 'AppPlugin' }, { packageClassList: null }]) {
      expect(() => withSelfImplementedPluginClasses(broken, replacements)).toThrow('IOS_PACKAGE_CLASS_LIST_MISSING');
    }
  });

  it('keeps every other key of the config untouched', () => {
    expect(withSelfImplementedPluginClasses(config, replacements).appId).toBe('dev.neo.companion.preview');
  });
});
