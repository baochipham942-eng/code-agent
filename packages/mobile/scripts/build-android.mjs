import './remote-only.mjs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const build = Number(process.env.NEO_MOBILE_BUILD);
if (!Number.isSafeInteger(build) || build < 1) throw new Error('POSITIVE_NEO_MOBILE_BUILD_REQUIRED');
if (!process.env.ANDROID_HOME || !process.env.JAVA_HOME) throw new Error('SDK_AND_JAVA_REQUIRED');
const root = resolve('../..');
const run = (command, args, cwd = process.cwd()) => execFileSync(command, args, { cwd, stdio: 'inherit' });
const capture = (command, args, cwd = process.cwd()) => execFileSync(command, args, { cwd, encoding: 'utf8' }).trim();
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('INVALID_VERSION');
run('npm', ['run', 'build']);
if (!existsSync('android')) run('node_modules/.bin/cap', ['add', 'android']);
const gradle = 'android/app/build.gradle';
const template = readFileSync(gradle, 'utf8');
if (!/versionCode\s+\d+/.test(template) || !/versionName\s+"[^"]+"/.test(template)) throw new Error('ANDROID_TEMPLATE_CHANGED');
writeFileSync(gradle, template.replace(/versionCode\s+\d+/, `versionCode ${build}`).replace(/versionName\s+"[^"]+"/, `versionName "${version}"`));
run('node_modules/.bin/cap', ['sync', 'android']);
run('./gradlew', ['--offline', '--no-daemon', '--max-workers=2', 'assembleDebug'], resolve('android'));
mkdirSync('.artifacts', { recursive: true });
const apk = `.artifacts/neo-mobile-${version}-${build}.apk`;
copyFileSync('android/app/build/outputs/apk/debug/app-debug.apk', apk);
const sourceStatus = capture('git', ['status', '--porcelain'], root);
const manifest = {
  kind: 'mobile-base-preview', platform: 'android', version, build, appId: 'dev.neo.companion.preview',
  sourceSha: capture('git', ['rev-parse', 'HEAD'], root), sourceDirty: sourceStatus.length > 0,
  sourceTree: capture('git', ['rev-parse', 'HEAD^{tree}'], root), fixtures: process.env.NEO_MOBILE_FIXTURES === '1',
  lockSha256: hash('package-lock.json'), apk: apk.split('/').at(-1), apkSha256: hash(apk),
  node: process.version, npm: capture('npm', ['--version']),
  sdk: readFileSync('android/variables.gradle', 'utf8'),
  sdkPackages: ['platforms', 'build-tools', 'platform-tools'].flatMap(group => {
    const dir = resolve(process.env.ANDROID_HOME, group);
    const entries = group === 'platform-tools' ? [''] : readdirSync(dir);
    return entries.map(entry => ({ component: [group, entry].filter(Boolean).join('/'),
      properties: readFileSync(resolve(dir, entry, 'source.properties'), 'utf8') }));
  }),
};
writeFileSync(`${apk}.json`, JSON.stringify(manifest, null, 2) + '\n');
console.log(`APK_BUILT ${manifest.apk} sha256=${manifest.apkSha256} source=${manifest.sourceSha} dirty=${manifest.sourceDirty}`);
