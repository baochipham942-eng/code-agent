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
let talkbackAvailable = false;
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
async function pressBack() {
  await context('NATIVE_APP');
  await call('POST', '/appium/device/press_keycode', { keycode: 4 });
  await delay(500);
  await context(webContext);
}
async function imeShown() {
  await context('NATIVE_APP');
  const shown = await call('GET', '/appium/device/is_keyboard_shown');
  await context(webContext);
  return shown;
}
// Swipe by CSS-pixel coordinates (converted to native pixels via the current window rect).
async function swipe(cssX1, cssY1, cssX2, cssY2, duration = 300) {
  await context(webContext);
  const cssWidth = await evaluate('return innerWidth');
  await context('NATIVE_APP');
  const rect = await call('GET', '/window/rect');
  const s = rect.width / cssWidth;
  const clamp = (x, y) => ({
    x: Math.max(0, Math.min(rect.width - 2, Math.round(x * s))),
    y: Math.max(0, Math.min(rect.height - 2, Math.round(y * s))),
  });
  const from = clamp(cssX1, cssY1), to = clamp(cssX2, cssY2);
  await call('POST', '/actions', { actions: [{ type: 'pointer', id: 'mn-swipe', parameters: { pointerType: 'touch' }, actions: [
    { type: 'pointerMove', duration: 0, x: from.x, y: from.y },
    { type: 'pointerDown', button: 0 },
    { type: 'pointerMove', duration, x: to.x, y: to.y },
    { type: 'pointerUp', button: 0 },
  ] }] });
  await delay(350);
  await context(webContext);
}
async function hideKeyboard() {
  await context('NATIVE_APP');
  if (await call('GET', '/appium/device/is_keyboard_shown')) await call('POST', '/appium/device/press_keycode', { keycode: 4 });
  await delay(250); await context(webContext);
}
// Re-attach after activity recreation (font scale, process death): the webview keeps its
// context name, so force a NATIVE round-trip to drop the stale chromedriver binding first.
async function reattach() {
  for (let n = 0; n < 20; n++) {
    try {
      await call('POST', '/context', { name: 'NATIVE_APP' }).catch(() => {});
      await attach();
      await evaluate('return document.readyState');
      return;
    } catch { await delay(600); }
  }
  throw new Error('WEBVIEW_REATTACH_FAILED');
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
  // MN-01: edge-to-edge content under the status bar, real safe-area inset, no double inset.
  const bars = await evaluate(`return (function(){
    const cs = getComputedStyle(document.documentElement);
    const top = parseFloat(cs.getPropertyValue('--safe-area-inset-top'));
    const bar = document.querySelector('.topbar').getBoundingClientRect();
    const app = document.querySelector('.app').getBoundingClientRect();
    return { top, topbarTop: bar.top, screenH: screen.height, innerH: innerHeight, appH: app.height };
  })()`);
  check('mn01-edge-to-edge-under-status-bar', bars.innerH === bars.screenH && bars.appH === bars.screenH, bars);
  check('mn01-safe-area-injected', Number.isFinite(bars.top) && bars.top > 0, bars);
  check('mn01-content-respects-inset-once', bars.topbarTop === bars.top, bars);
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
  // MN-01: the IME owns the container padding while visible; the CSS bottom inset must stay 0 and the
  // composer must dock to the keyboard instead of floating one keyboard-height above it.
  const imeInset = await evaluate(`return { safeBottom: getComputedStyle(document.documentElement).getPropertyValue('--safe-area-inset-bottom'), vh: visualViewport.height };`);
  check('mn01-ime-single-subtraction', ime && imeInset.safeBottom === '0px' && geometry.bottom >= imeInset.vh - 40, { imeInset, geometry });
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
  const scrimCover = await evaluate(`return (function(){ const r=document.querySelector('.sheet-layer .scrim').getBoundingClientRect(); return { top: r.top, height: r.height, screenH: screen.height }; })()`);
  check('mn01-scrim-covers-status-bar', scrimCover.top === 0 && scrimCover.height === scrimCover.screenH, scrimCover);
  await nativeShot('07-sheet-dark-statusbar-icons');
  await clickLabel('返回上一级'); await click('open-about');
  check('installed-app-info', await evaluate(`return document.querySelector('[data-testid=app-version]').textContent.includes(${JSON.stringify(`${manifest.version}（${manifest.build}）`)})`));
  await nativeShot('03-about');
  await clickLabel('关闭弹层');
  check('close-returns-to-drawer', await evaluate('return !!document.querySelector(".drawer") && !document.querySelector("[role=dialog]")'));
  const regions = await evaluate('const f=document.querySelector(".drawer-functions").getBoundingClientRect(),p=document.querySelector(".personal-bar").getBoundingClientRect();document.querySelector(".drawer-history").scrollTop=600;return {functionTop:f.top,personalBottom:p.bottom};');
  await delay(200);
  check('drawer-fixed-regions', await evaluate(`return document.querySelector('.drawer-functions').getBoundingClientRect().top === ${regions.functionTop} && document.querySelector('.personal-bar').getBoundingClientRect().bottom === ${regions.personalBottom}`));
  await nativeShot('04-drawer');
  // MN-02: real dispatcher presses. With the IME shown, Android consumes the back itself
  // (keyboard down, selection and sheet untouched); once the app receives backs the
  // coordinator order is selection -> sheet pages -> drawer -> OS.
  await click('open-settings'); await click('open-profile');
  const nickname = (await call('POST', '/element', { using: 'css selector', value: '#nickname' }))['element-6066-11e4-a52e-4f735466cecf'];
  await call('POST', `/element/${nickname}/click`, {}); await delay(700);
  const nicknameText = '未提交昵称';
  await call('POST', `/element/${nickname}/value`, { text: nicknameText, value: [...nicknameText] }); await delay(400);
  const imeOverSheet = await imeShown();
  await evaluate('const i=document.querySelector("#nickname"); i.setSelectionRange(0, 2); return i.selectionStart !== i.selectionEnd;');
  await pressBack();
  check('mn02-ime-open-back-dismisses-keyboard-only', imeOverSheet && !(await imeShown()) && await evaluate('return document.querySelector("#nickname").selectionStart !== document.querySelector("#nickname").selectionEnd && document.querySelectorAll("[role=dialog]").length === 1'), { imeOverSheet });
  await pressBack();
  check('mn02-back-clears-selection-first', await evaluate('return document.querySelector("#nickname").selectionStart === document.querySelector("#nickname").selectionEnd && !!document.querySelector(\'[data-page="profile"]\')'));
  await pressBack();
  check('mn02-back-pops-one-sheet-page', await evaluate(`return !!document.querySelector('[data-page="settings"]')`));
  await pressBack();
  check('mn02-back-closes-sheet-to-origin', await evaluate('return !!document.querySelector(".drawer") && !document.querySelector("[role=dialog]")'));
  await pressBack();
  check('mn02-back-closes-drawer', await evaluate('return !document.querySelector(".drawer") && !document.querySelector("[role=dialog]")'));
  check('mn02-back-keeps-route-and-draft', await evaluate(`return !!document.querySelector('h1') && document.querySelector('textarea').value === ${JSON.stringify(draft)}`));
  // MN-03: main-surface swipes — right opens the list, left has no entry, below-threshold settles back.
  const metrics = await evaluate('return { w: innerWidth, h: innerHeight };');
  const welcomeY = await evaluate('const r=document.querySelector(".conversation h1").getBoundingClientRect(); return r.y + r.height / 2;');
  await swipe(30, welcomeY, 30 + 60, welcomeY);
  check('mn03-swipe-below-threshold-opens-nothing', await evaluate('return !document.querySelector(".drawer") && !document.querySelector("[role=dialog]")'));
  await swipe(30, welcomeY, metrics.w - 40, welcomeY);
  check('mn03-right-swipe-opens-drawer', await evaluate('return !!document.querySelector(".drawer") && !document.querySelector("[role=dialog]")'));
  await pressBack(); // the drawer covers the scrim center, so close it the other native way
  await swipe(metrics.w * 0.6, metrics.h * 0.4, 30, metrics.h * 0.4);
  check('mn03-left-swipe-on-main-opens-nothing', await evaluate(`return !document.querySelector(".drawer") && !document.querySelector("[role=dialog]") && document.querySelector('textarea').value === ${JSON.stringify(draft)}`));
  await click('open-drawer');
  await evaluate('document.querySelector(".drawer-history").scrollTop=0;return true'); await click('fixture-session');
  await evaluate('document.querySelector("[data-testid=history]").scrollTop=50000;return true'); await delay(500);
  const before = await evaluate('const h=document.querySelector("[data-testid=history]");return {count:Number(h.dataset.count),rendered:h.querySelectorAll("article").length,anchor:h.scrollTop};');
  await click('open-more'); await delay(1200);
  const handle = await evaluate('const r=document.querySelector("[data-testid=sheet-handle]").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,width:innerWidth,height:innerHeight};');
  await context('NATIVE_APP'); const rect = await call('GET', '/window/rect'); const scale = rect.width / handle.width;
  const x = Math.round(handle.x * scale), y = Math.round(rect.height - handle.height * scale + handle.y * scale);
  // MN-03: drags below the dismissal threshold must settle back, and content drags must not close the sheet.
  await swipe(handle.x, handle.y, handle.x, handle.y + 50);
  check('mn03-sheet-drag-below-threshold-stays-open', await evaluate('return !!document.querySelector(\'[data-page="more"]\')'));
  const contentCenter = await evaluate('const r=document.querySelector(".sheet-content").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + Math.min(60, r.height / 2) };');
  await swipe(contentCenter.x, contentCenter.y, contentCenter.x, contentCenter.y + 110);
  check('mn03-sheet-content-drag-does-not-dismiss', await evaluate('return !!document.querySelector(\'[data-page="more"]\')'));
  await context('NATIVE_APP'); // the dismissal drag targets native screen coordinates
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
  await call('POST', '/appium/device/activate_app', { appId }); await delay(350); await reattach();
  check('process-restart-preserves-new-draft', await evaluate(`return !!document.querySelector('h1') && document.querySelector('textarea').value === ${JSON.stringify(draft)}`));
  check('process-restart-preserves-theme', await evaluate('return document.documentElement.dataset.theme === "dark"'));
  await nativeShot('06-restarted');
  // MN-04: system font scale is a real OS setting; CSS zoom is never a substitute. The activity
  // recreates on font-scale changes, which also re-exercises preference rehydration.
  adb('shell', 'settings', 'put', 'system', 'font_scale', '1.0'); await delay(1200); await reattach();
  const font100 = await evaluate(`return (function(){
    const h1 = parseFloat(getComputedStyle(document.querySelector('h1')).fontSize);
    const send = document.querySelector('[data-testid=send]').getBoundingClientRect().height;
    const open = document.querySelector('[data-testid=open-drawer]').getBoundingClientRect().height;
    return { h1, send, open, draft: document.querySelector('textarea').value };
  })()`);
  adb('shell', 'settings', 'put', 'system', 'font_scale', '2.0'); await delay(1200); await reattach();
  const font200 = await evaluate(`return (function(){
    const h1 = parseFloat(getComputedStyle(document.querySelector('h1')).fontSize);
    const send = document.querySelector('[data-testid=send]').getBoundingClientRect().height;
    const open = document.querySelector('[data-testid=open-drawer]').getBoundingClientRect().height;
    return { h1, send, open, draft: document.querySelector('textarea').value };
  })()`);
  check('mn04-system-font-scale-applies', font200.h1 > font100.h1, { font100, font200 });
  check('mn04-touch-targets-stay-48dp', font200.send >= 48 && font200.open >= 48, { font200 });
  check('mn04-font-recreation-keeps-draft', font200.draft === draft, { font200 });
  await nativeShot('08-font-scale-200');
  adb('shell', 'settings', 'put', 'system', 'font_scale', '1.0'); await delay(1200); await reattach();
  // MN-04 TalkBack: the image ships no TalkBack package, so screen-reader acceptance is NOT_RUN below.
  talkbackAvailable = /talkback/i.test(adb('shell', 'pm', 'list', 'packages').toString());
  if (talkbackAvailable) {
    adb('shell', 'settings', 'put', 'secure', 'enabled_accessibility_services', 'com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService');
    adb('shell', 'settings', 'put', 'secure', 'accessibility_enabled', '1'); await delay(1200); await reattach();
    const labeled = await evaluate('return !!document.querySelector(\'[aria-label]\') && !!document.querySelector(\'[role=dialog],[aria-label=会话列表],[aria-label=消息草稿]\')');
    check('mn04-talkback-exposes-labelled-nodes', labeled);
    adb('shell', 'settings', 'put', 'secure', 'enabled_accessibility_services', 'null');
    adb('shell', 'settings', 'put', 'secure', 'accessibility_enabled', '0'); await delay(800); await reattach();
  }
  // MN-05: system night mode with appearance=system, manual override wins, process death restores.
  await click('open-drawer'); await click('open-settings'); await click('open-appearance'); await click('theme-system');
  await clickLabel('关闭弹层');
  adb('shell', 'cmd', 'uimode', 'night', 'yes'); await delay(1000); await reattach();
  check('mn05-system-night-follows-dark', await evaluate('return document.documentElement.dataset.theme === "dark"'));
  await nativeShot('09-night-system-dark');
  adb('shell', 'cmd', 'uimode', 'night', 'no'); await delay(1000); await reattach();
  check('mn05-system-day-follows-light', await evaluate('return document.documentElement.dataset.theme === "light"'));
  await nativeShot('10-day-system-light');
  // Closing the sheet above returned to the drawer, which is still open here.
  await click('open-settings'); await click('open-appearance'); await click('theme-light');
  await clickLabel('关闭弹层');
  adb('shell', 'cmd', 'uimode', 'night', 'yes'); await delay(1000); await reattach();
  check('mn05-manual-override-beats-system', await evaluate('return document.documentElement.dataset.theme === "light"'));
  await nativeShot('11-manual-light-under-night');
  await context('NATIVE_APP'); await call('POST', '/appium/device/terminate_app', { appId });
  await call('POST', '/appium/device/activate_app', { appId }); await delay(500); await reattach();
  check('mn05-process-restart-keeps-light-and-draft', await evaluate(`return document.documentElement.dataset.theme === "light" && document.querySelector('textarea').value === ${JSON.stringify(draft)}`));
  adb('shell', 'cmd', 'uimode', 'night', 'no'); await delay(1000); await reattach();
  // Leave the recorded dark appearance the next update run expects, then hand the final back to the OS.
  await click('open-drawer'); await click('open-settings'); await click('open-appearance'); await click('theme-dark');
  await clickLabel('关闭弹层');
  await pressBack(); // closes the drawer the sheet returned to
  await pressBack(); // root conversation: hand back to the OS
  await context('NATIVE_APP');
  const foreground = await call('GET', '/appium/device/current_package');
  check('mn02-root-back-hands-to-os', foreground !== appId, { foreground });
} catch (error) {
  checks.push({ name: 'execution', status: 'FAIL', reason: error.message }); process.exitCode = 1;
} finally {
  if (session) await request('DELETE', `/session/${session}`).catch(() => { process.exitCode = 1; });
  // Crash-safe hygiene: never leave system settings (font scale, night mode) modified on the runner.
  for (const restore of [
    ['shell', 'settings', 'delete', 'system', 'font_scale'],
    ['shell', 'cmd', 'uimode', 'night', 'no'],
    ['shell', 'settings', 'put', 'secure', 'enabled_accessibility_services', 'null'],
    ['shell', 'settings', 'put', 'secure', 'accessibility_enabled', '0'],
  ]) { try { adb(...restore); } catch { /* best effort */ } }
  const report = { platform: 'android', deviceKind: 'emulator', sourceSha: manifest.sourceSha,
    apkSha256: manifest.apkSha256, version: manifest.version, build: manifest.build, checks,
    passed: checks.filter(c => c.status === 'PASS').length, failed: checks.filter(c => c.status === 'FAIL').length,
    notRun: ['iPhone acceptance', 'native Chinese IME (separate check)', 'Host and cross-network operation',
      'MN-02 predictive back commit/cancel: this image is Android 12 (API 32), predictive back needs API 33+; the enableOnBackInvokedCallback opt-in is wired for newer devices',
      ...(talkbackAvailable ? [] : ['MN-04 TalkBack: the emulator image ships no TalkBack service package; DOM focus or CSS zoom cannot substitute'])] };
  writeFileSync(`${dir}/results.json`, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report));
}
