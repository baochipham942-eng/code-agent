import './remote-only.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [serial, apkArgument, driverArgument] = process.argv.slice(2);
if (!serial || !apkArgument || !driverArgument) throw new Error('USAGE: android:verify SERIAL APK CHROMEDRIVER');
const apk = resolve(apkArgument), driver = resolve(driverArgument);
const manifest = JSON.parse(readFileSync(`${apk}.json`, 'utf8'));
const appId = 'dev.neo.companion.preview';
assert.equal(manifest.appId, appId);
assert.equal(manifest.fixtures, true, 'fixture validation requires a labelled fixture build');
assert.equal(createHash('sha256').update(readFileSync(apk)).digest('hex'), manifest.apkSha256);
const dir = `.reports/android-${manifest.build}`;
mkdirSync(dir, { recursive: true });
const checks = [];
const adb = (...args) => execFileSync('adb', ['-s', serial, ...args], { timeout: 60000 });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let session, webContext;
const check = (name, condition, detail = {}) => {
  checks.push({ name, status: condition ? 'PASS' : 'FAIL', ...detail });
  assert.ok(condition, name);
};
async function request(method, path, body) {
  const response = await fetch(`http://127.0.0.1:4727${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120000),
  });
  const json = await response.json();
  if (!response.ok || json.value?.error) throw new Error(`${path}: ${json.value?.error ?? response.status}`);
  return json.value;
}
const call = (method, path, body) => request(method, `/session/${session}${path}`, body);
const context = name => call('POST', '/context', { name });
const evaluate = script => call('POST', '/execute/sync', { script, args: [] });
async function attach() {
  for (let n = 0; n < 15; n++) {
    const contexts = await call('GET', '/contexts');
    webContext = contexts.find(value => value.includes(appId));
    if (webContext) { await context(webContext); return; }
    await delay(400);
  }
  throw new Error('EXPECTED_WEBVIEW_MISSING');
}
async function click(testId) {
  const element = await call('POST', '/element', { using: 'css selector', value: `[data-testid="${testId}"]` });
  await call('POST', `/element/${element['element-6066-11e4-a52e-4f735466cecf']}/click`, {});
  await delay(150);
}
async function clickLabel(label) {
  const element = await call('POST', '/element', { using: 'css selector', value: `[aria-label="${label}"]` });
  await call('POST', `/element/${element['element-6066-11e4-a52e-4f735466cecf']}/click`, {});
  await delay(150);
}
async function nativeShot(name) {
  await context('NATIVE_APP');
  writeFileSync(`${dir}/${name}.png`, Buffer.from(await call('GET', '/screenshot'), 'base64'));
  await context(webContext);
}
async function hideKeyboard() {
  await context('NATIVE_APP');
  if (await call('GET', '/appium/device/is_keyboard_shown')) await call('POST', '/appium/device/press_keycode', { keycode: 4 });
  await delay(250); await context(webContext);
}
try {
  adb('install', '-r', apk);
  const installed = adb('shell', 'dumpsys', 'package', appId).toString();
  check('installed-package-version', installed.includes(`versionName=${manifest.version}`) &&
    new RegExp(`versionCode=${manifest.build}\\b`).test(installed));
  const result = await request('POST', '/session', { capabilities: { alwaysMatch: {
    platformName: 'Android', 'appium:automationName': 'UiAutomator2', 'appium:udid': serial,
    'appium:appPackage': appId, 'appium:appActivity': '.MainActivity', 'appium:noReset': true,
    'appium:forceAppLaunch': true, 'appium:systemPort': 8228, 'appium:chromedriverExecutable': driver,
    'appium:newCommandTimeout': 120, 'appium:adbExecTimeout': 60000,
  }, firstMatch: [{}] } });
  session = result.sessionId; await attach(); await delay(400);
  check('ordinary-cold-start-new-conversation', await evaluate('return !!document.querySelector("h1")'));
  const existing = await evaluate('return document.querySelector("textarea").value');
  const draft = 'neo-mobile-你好\n多行草稿';
  if (process.env.NEO_MOBILE_EXPECT_UPDATE === '1') {
    check('update-preserves-draft', existing === draft);
    check('update-preserves-appearance', await evaluate('return document.documentElement.dataset.theme === "dark"'));
  } else assert.ok(existing === '' || existing === draft, 'unexpected existing draft; do not overwrite');
  await nativeShot('01-new-conversation');
  const element = await call('POST', '/element', { using: 'css selector', value: '[data-testid="draft"]' });
  const editor = element['element-6066-11e4-a52e-4f735466cecf'];
  await call('POST', `/element/${editor}/click`, {}); await call('POST', `/element/${editor}/clear`, {});
  await call('POST', `/element/${editor}/value`, { text: draft, value: [...draft] }); await delay(500);
  check('multiline-input-retained', await evaluate(`return document.querySelector('textarea').value === ${JSON.stringify(draft)}`),
    { inputSource: 'webdriver-text-injection', boundary: 'Not Chinese IME evidence' });
  const geometry = await evaluate('const r=document.querySelector("[data-testid=send]").getBoundingClientRect(); return {bottom:r.bottom,height:visualViewport.height,width:innerWidth};');
  await context('NATIVE_APP'); const ime = await call('GET', '/appium/device/is_keyboard_shown'); await context(webContext);
  check('keyboard-send-visible', ime && geometry.bottom <= geometry.height + 1, { geometry, keyboardShown: ime });
  await nativeShot('02-keyboard');
  // Composition is a controlled browser event here; the separate native IME check covers actual candidates.
  await evaluate('document.querySelector("textarea").dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true})); return true;');
  await click('send');
  check('composition-does-not-send', await evaluate('return !document.querySelector(".notice")'));
  await evaluate('document.querySelector("textarea").dispatchEvent(new CompositionEvent("compositionend",{bubbles:true})); return true;');
  await click('send');
  check('no-host-keeps-draft', await evaluate(`return document.querySelector('textarea').value === ${JSON.stringify(draft)} && !!document.querySelector('.notice')`));
  await hideKeyboard();
  await click('open-drawer'); await click('open-settings'); await click('open-appearance'); await click('theme-dark');
  check('one-sheet-and-theme-change', await evaluate('return document.querySelectorAll("[role=dialog]").length === 1 && document.documentElement.dataset.theme === "dark"'));
  await clickLabel('返回上一级'); await click('open-about');
  check('installed-app-info', await evaluate(`return document.querySelector('[data-testid=app-version]').textContent.includes(${JSON.stringify(`${manifest.version}（${manifest.build}）`)})`));
  await nativeShot('03-about');
  await clickLabel('关闭弹层');
  check('close-returns-to-drawer', await evaluate('return !!document.querySelector(".drawer") && !document.querySelector("[role=dialog]")'));
  const regions = await evaluate('const f=document.querySelector(".drawer-functions").getBoundingClientRect(),p=document.querySelector(".personal-bar").getBoundingClientRect();document.querySelector(".drawer-history").scrollTop=600;return {functionTop:f.top,personalBottom:p.bottom};');
  await delay(200);
  check('drawer-fixed-regions', await evaluate(`return document.querySelector('.drawer-functions').getBoundingClientRect().top === ${regions.functionTop} && document.querySelector('.personal-bar').getBoundingClientRect().bottom === ${regions.personalBottom}`));
  await nativeShot('04-drawer');
  await evaluate('document.querySelector(".drawer-history").scrollTop=0;return true'); await click('fixture-session');
  await evaluate('document.querySelector("[data-testid=history]").scrollTop=50000;return true'); await delay(500);
  const before = await evaluate('const h=document.querySelector("[data-testid=history]");return {count:Number(h.dataset.count),rendered:h.querySelectorAll("article").length,anchor:h.scrollTop};');
  await click('open-more'); await delay(1200);
  const handle = await evaluate('const r=document.querySelector("[data-testid=sheet-handle]").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,width:innerWidth,height:innerHeight};');
  await context('NATIVE_APP'); const rect = await call('GET', '/window/rect'); const scale = rect.width / handle.width;
  const x = Math.round(handle.x * scale), y = Math.round(rect.height - handle.height * scale + handle.y * scale);
  await call('POST', '/actions', { actions: [{ type: 'pointer', id: 'mobile-sheet', parameters: { pointerType: 'touch' }, actions: [
    { type: 'pointerMove', duration: 0, x, y }, { type: 'pointerDown', button: 0 },
    { type: 'pointerMove', duration: 300, x, y: Math.min(rect.height - 3, y + Math.round(105 * scale)) }, { type: 'pointerUp', button: 0 },
  ] }] });
  await context(webContext); await delay(250);
  check('native-sheet-drag-dismiss', await evaluate('return !document.querySelector("[role=dialog]")'));
  const after = await evaluate('const h=document.querySelector("[data-testid=history]");return {count:Number(h.dataset.count),rendered:h.querySelectorAll("article").length,anchor:h.scrollTop};');
  check('windowed-history-stream-anchor', after.count > before.count && after.rendered < 30 && after.anchor === before.anchor, { before, after, fixture: true });
  await nativeShot('05-history');
  await context('NATIVE_APP'); await call('POST', '/appium/device/press_keycode', { keycode: 3 });
  await call('POST', '/appium/device/activate_app', { appId }); await attach();
  check('foreground-restores-conversation', await evaluate('return !!document.querySelector("[data-testid=history]")'));
  await context('NATIVE_APP'); await call('POST', '/appium/device/terminate_app', { appId });
  await call('POST', '/appium/device/activate_app', { appId }); await attach(); await delay(350);
  check('process-restart-preserves-new-draft', await evaluate(`return !!document.querySelector('h1') && document.querySelector('textarea').value === ${JSON.stringify(draft)}`));
  check('process-restart-preserves-theme', await evaluate('return document.documentElement.dataset.theme === "dark"'));
  await nativeShot('06-restarted');
} catch (error) {
  checks.push({ name: 'execution', status: 'FAIL', reason: error.message }); process.exitCode = 1;
} finally {
  if (session) await request('DELETE', `/session/${session}`).catch(() => { process.exitCode = 1; });
  const report = { platform: 'android', deviceKind: 'emulator', sourceSha: manifest.sourceSha,
    apkSha256: manifest.apkSha256, version: manifest.version, build: manifest.build, checks,
    passed: checks.filter(c => c.status === 'PASS').length, failed: checks.filter(c => c.status === 'FAIL').length,
    notRun: ['iPhone acceptance', 'native Chinese IME (separate check)', 'Host and cross-network operation'] };
  writeFileSync(`${dir}/results.json`, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report));
}
