import './remote-only.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { profileCoversDevice, readMobileprovision, summarizeProfile } from './ios-package.mjs';

const [ipaArgument, handoffArgument] = process.argv.slice(2);
if (!ipaArgument) throw new Error('USAGE: ios:verify IPA [HANDOFF_COPY]');
const ipa = resolve(ipaArgument);
const manifest = JSON.parse(readFileSync(`${ipa}.json`, 'utf8'));
const appId = 'dev.neo.companion.preview';
const teamId = manifest.signing?.teamId ?? 'D7CVTJ72NV';
const dir = `.reports/ios-${manifest.build}`;
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const checks = [];
const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' });
const capture = (command, args) => execFileSync(command, args, { encoding: 'utf8' }).trim();
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const check = (name, condition, detail = {}) => {
  checks.push({ name, status: condition ? 'PASS' : 'FAIL', ...detail });
  assert.ok(condition, name);
};
try {
  check('manifest-app-id', manifest.appId === appId, { appId: manifest.appId });
  check('ipa-hash-matches-manifest', sha256(ipa) === manifest.ipaSha256);
  if (handoffArgument) check('handoff-copy-identical-bytes', sha256(resolve(handoffArgument)) === manifest.ipaSha256);
  const entries = capture('unzip', ['-Z1', ipa]).split('\n');
  const appBundle = entries.map(line => line.match(/^Payload\/([^/]+\.app)\/$/)?.[1]).find(Boolean);
  if (!appBundle) throw new Error('EXPECTED_APP_BUNDLE_MISSING');
  const payload = `${dir}/payload`;
  mkdirSync(payload, { recursive: true });
  run('unzip', ['-q', '-o', ipa, '-d', payload]);
  const appPath = `${payload}/Payload/${appBundle}`;
  check('embedded-mobileprovision-present', existsSync(`${appPath}/embedded.mobileprovision`),
    { note: 'App Store exports strip the profile; Ad Hoc keeps it' });
  const profilePlist = readMobileprovision(readFileSync(`${appPath}/embedded.mobileprovision`));
  const summary = summarizeProfile(profilePlist);
  check('ad-hoc-signing-method', summary.method === 'ad-hoc', { method: summary.method });
  check('profile-not-expired', !summary.expired, { expiresAt: summary.expiresAt?.toISOString() ?? null });
  check('profile-team', summary.teamIdentifier.includes(teamId), { teamIdentifier: summary.teamIdentifier });
  const plistBuddy = key => capture('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, `${appPath}/Info.plist`]);
  check('package-version-not-design-mock',
    plistBuddy('CFBundleShortVersionString') === manifest.version && plistBuddy('CFBundleVersion') === String(manifest.build),
    { found: `${plistBuddy('CFBundleShortVersionString')}(${plistBuddy('CFBundleVersion')})`, expected: `${manifest.version}(${manifest.build})` });
  // codesign -dvv writes its report to stderr; spawnSync exposes both streams without throwing.
  const signed = spawnSync('codesign', ['-dvv', appPath], { encoding: 'utf8' });
  const signature = `${signed.stdout ?? ''}\n${signed.stderr ?? ''}`;
  check('codesign-signature-present', /Identifier=/.test(signature) && /TeamIdentifier=/.test(signature));
  check('codesign-team', new RegExp(`TeamIdentifier=${teamId}`).test(signature));
  const expected = process.env.NEO_IOS_EXPECTED_UDID;
  if (expected) check('covers-expected-device', profileCoversDevice(profilePlist, expected));
  else checks.push({ name: 'covers-expected-device', status: 'NOT_RUN', reason: 'NEO_IOS_EXPECTED_UDID not provided' });
} catch (error) {
  checks.push({ name: 'execution', status: 'FAIL', reason: error.message }); process.exitCode = 1;
} finally {
  const report = { platform: 'ios', deviceKind: 'pre-install package inspection', sourceSha: manifest.sourceSha,
    ipaSha256: manifest.ipaSha256, version: manifest.version, build: manifest.build, checks,
    passed: checks.filter(c => c.status === 'PASS').length, failed: checks.filter(c => c.status === 'FAIL').length,
    notRun: checks.filter(c => c.status === 'NOT_RUN').concat([
      { name: 'iPhone on-device install (MI-01)', reason: 'no connected iPhone on the runner' },
      { name: 'iPhone over-install update (MI-02)', reason: 'no connected iPhone on the runner' },
      { name: 'Host and cross-network operation' },
    ]) };
  writeFileSync(`${dir}/results.json`, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report));
}
