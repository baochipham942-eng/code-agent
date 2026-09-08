import './remote-only.mjs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { extractNativeTargetId, exportOptionsXml, patchPbxprojVersions, profileCoversDevice, readMobileprovision, sharedSchemeXml, summarizeProfile } from './ios-package.mjs';

const build = Number(process.env.NEO_MOBILE_BUILD);
if (!Number.isSafeInteger(build) || build < 1) throw new Error('POSITIVE_NEO_MOBILE_BUILD_REQUIRED');
const root = resolve('../..');
const run = (command, args, cwd = process.cwd()) => execFileSync(command, args, { cwd, stdio: 'inherit' });
const capture = (command, args, cwd = process.cwd()) => execFileSync(command, args, { cwd, encoding: 'utf8' }).trim();
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('INVALID_VERSION');
const appId = 'dev.neo.companion.preview';
const teamId = process.env.NEO_IOS_TEAM_ID ?? 'D7CVTJ72NV';
const expectedDevice = process.env.NEO_IOS_EXPECTED_UDID ?? null;
const profileFile = resolveProfileFile();
const style = profileFile || process.env.NEO_IOS_SIGNING_STYLE === 'manual' ? 'manual' : 'automatic';
const identity = process.env.NEO_IOS_IDENTITY ?? findIdentity();

function resolveProfileFile() {
  if (process.env.NEO_IOS_PROFILE) return resolve(process.env.NEO_IOS_PROFILE);
  for (const directory of ['Provisioning Profiles', 'Provisioning Profiles/Work']) {
    const dir = resolve(homedir(), 'Library/MobileDevice', directory);
    if (!existsSync(dir)) continue;
    const match = readdirSync(dir).find(file => file.endsWith('.mobileprovision'));
    if (match) return resolve(dir, match);
  }
  return null;
}

function findIdentity() {
  try {
    return capture('security', ['find-identity', '-v', '-p', 'codesigning']).split('\n')
      .map(line => line.match(/"([^"]*(?:iPhone Distribution|Apple Distribution|Apple Development)[^"]*)"/)?.[1])
      .filter(name => name?.includes(teamId))[0] ?? null;
  } catch { return null; }
}

const missing = [];
let xcode = null;
try { xcode = capture('xcodebuild', ['-version']); } catch (error) {
  missing.push(`xcodebuild unusable: ${String(error.stderr ?? error.message).split('\n')[0].trim()}`);
}
if (style === 'manual' && !identity) missing.push(`no iOS signing identity for team ${teamId} (security find-identity -v -p codesigning)`);
if (style === 'manual' && !profileFile) missing.push('no .mobileprovision (set NEO_IOS_PROFILE or place one in ~/Library/MobileDevice/Provisioning Profiles/)');
if (!expectedDevice) missing.push('NEO_IOS_EXPECTED_UDID required so Ad Hoc export fails closed unless the profile covers the target iPhone');
if (missing.length > 0) throw new Error(`IOS_PREREQUISITES_MISSING: ${missing.join(' | ')}`);

run('npm', ['run', 'build']);
if (!existsSync('ios')) run('node_modules/.bin/cap', ['add', 'ios']);
const pbxproj = 'ios/App/App.xcodeproj/project.pbxproj';
const pbxprojContent = readFileSync(pbxproj, 'utf8');
const targetId = extractNativeTargetId(pbxprojContent);
writeFileSync(pbxproj, patchPbxprojVersions(pbxprojContent, version, build));
const scheme = 'ios/App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme';
if (!existsSync(scheme)) {
  mkdirSync('ios/App/App.xcodeproj/xcshareddata/xcschemes', { recursive: true });
  writeFileSync(scheme, sharedSchemeXml(targetId));
}
run('node_modules/.bin/cap', ['sync', 'ios']);
copyFileSync(resolve(root, 'src-tauri/icons/ios/AppIcon-512@2x.png'),
  resolve('ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'));
mkdirSync('.artifacts/ios', { recursive: true });
const archive = '.artifacts/ios/App.xcarchive';
const profileSummary = profileFile ? summarizeProfile(readMobileprovision(readFileSync(profileFile))) : null;
const profileName = profileSummary ? (profileSummary.name ?? profileSummary.uuid) : null;
const archiveArgs = ['-project', 'ios/App/App.xcodeproj', '-scheme', 'App', '-configuration', 'Release',
  '-destination', 'generic/platform=iOS', '-archivePath', archive, 'archive'];
if (style === 'manual') {
  archiveArgs.push('CODE_SIGN_STYLE=Manual', `PROVISIONING_PROFILE_SPECIFIER=${profileName}`, `CODE_SIGN_IDENTITY=${identity}`);
} else archiveArgs.push('-allowProvisioningUpdates');
run('xcodebuild', archiveArgs);
const exportPath = '.artifacts/ios-export';
rmSync(exportPath, { recursive: true, force: true });
writeFileSync('.artifacts/ExportOptions.plist', exportOptionsXml({ method: 'ad-hoc', teamId, style, appId, profileName, identity }));
run('xcodebuild', ['-exportArchive', '-archivePath', archive, '-exportOptionsPlist', '.artifacts/ExportOptions.plist', '-exportPath', exportPath]);
const exported = readdirSync(exportPath).find(file => file.endsWith('.ipa'));
if (!exported) throw new Error('IPA_EXPORT_MISSING');
mkdirSync('.artifacts', { recursive: true });
const ipa = `.artifacts/neo-mobile-${version}-${build}.ipa`;
copyFileSync(`${exportPath}/${exported}`, ipa);
const appBundle = capture('unzip', ['-Z1', ipa]).split('\n').map(line => line.match(/^Payload\/([^/]+\.app)\/$/)?.[1]).find(Boolean);
if (!appBundle) throw new Error('APP_BUNDLE_MISSING_IN_IPA');
const embeddedPlist = readMobileprovision(execFileSync('unzip', ['-p', ipa, `Payload/${appBundle}/embedded.mobileprovision`], { maxBuffer: 1 << 24 }));
const summary = summarizeProfile(embeddedPlist);
if (summary.method !== 'ad-hoc') throw new Error(`NOT_AD_HOC: exported profile is ${summary.method}`);
if (summary.expired) throw new Error(`PROFILE_EXPIRED: ${summary.expiresAt.toISOString()}`);
if (!profileCoversDevice(embeddedPlist, expectedDevice)) throw new Error('PROFILE_DOES_NOT_COVER_EXPECTED_DEVICE');
const sourceStatus = capture('git', ['status', '--porcelain'], root);
const manifest = {
  kind: 'mobile-base-preview', platform: 'ios', version, build, appId,
  sourceSha: capture('git', ['rev-parse', 'HEAD'], root), sourceDirty: sourceStatus.length > 0,
  sourceTree: capture('git', ['rev-parse', 'HEAD^{tree}'], root), fixtures: process.env.NEO_MOBILE_FIXTURES === '1',
  lockSha256: hash('package-lock.json'), ipa: ipa.split('/').at(-1), ipaSha256: hash(ipa),
  node: process.version, npm: capture('npm', ['--version']),
  xcode, sdk: capture('xcodebuild', ['-showsdks']).split(/\r?\n/).filter(line => /iphoneos|iphonesimulator/.test(line)),
  signing: {
    style, method: 'ad-hoc', teamId, identity: identity ?? '(xcodebuild automatic signing)',
    profile: summary, coversExpectedDevice: expectedDevice ? profileCoversDevice(embeddedPlist, expectedDevice) : null,
  },
};
writeFileSync(`${ipa}.json`, JSON.stringify(manifest, null, 2) + '\n');
console.log(`IPA_BUILT ${manifest.ipa} sha256=${manifest.ipaSha256} source=${manifest.sourceSha} dirty=${manifest.sourceDirty}`);
