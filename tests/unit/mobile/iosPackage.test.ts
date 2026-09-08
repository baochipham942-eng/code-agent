import { describe, expect, it } from 'vitest';
import {
  exportOptionsXml, extractNativeTargetId, extractPlistXml, parsePlistXml, patchPbxprojVersions,
  profileCoversDevice, readMobileprovision, summarizeProfile,
} from '../../../packages/mobile/scripts/ios-package.mjs';

const profileXml = ({ taskAllow, devices, expires }: { taskAllow?: boolean; devices?: string[]; expires: string }) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Name</key><string>Neo Preview AdHoc</string>
  <key>UUID</key><string>AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE</string>
  <key>TeamName</key><string>jay lem</string>
  <key>TeamIdentifier</key>
  <array><string>D7CVTJ72NV</string></array>
  <key>CreationDate</key><date>2026-09-01T08:00:00Z</date>
  <key>ExpirationDate</key><date>${expires}</date>
  ${devices === undefined ? '' : `<key>ProvisionedDevices</key>
  <array>${devices.map(device => `<string>${device}</string>`).join('')}</array>`}
  <key>Entitlements</key>
  <dict>
    <key>application-identifier</key><string>D7CVTJ72NV.dev.neo.companion.preview</string>
    <key>aps-environment</key><string>production</string>
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
    const xml = exportOptionsXml({ method: 'ad-hoc', teamId: 'D7CVTJ72NV', style: 'manual', appId: 'dev.neo.companion.preview', profileName: 'Neo Preview AdHoc', identity: 'iPhone Distribution: jay lem (D7CVTJ72NV)' });
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
