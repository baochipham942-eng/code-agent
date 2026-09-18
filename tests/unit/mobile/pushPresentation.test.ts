import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createNotificationStore } from '../../../packages/mobile/src/stores/notificationStore';
import { createNotificationPort } from '../../../packages/mobile/src/platform/notifications';
import type { NotificationPort } from '../../../packages/mobile/src/platform/ports';
import { messages, runOutcomeCopy } from '../../../packages/mobile/src/i18n';
import { LOCALIZABLE_REGIONS, localizableStrings, pushAlertStrings as mapPushAlerts, withLocalizableStrings } from '../../../packages/mobile/scripts/ios-package.mjs';

/** 与 build-ios 同一种拼法：文案全部取自 i18n。 */
const pushAlertStrings = (language: string) => {
  const text = messages(language);
  return mapPushAlerts(text, runOutcomeCopy(text, 'failed'), runOutcomeCopy(text, 'failed', 'MODEL_AUTH'), runOutcomeCopy(text, 'failed', 'MODEL_UNAVAILABLE'), runOutcomeCopy(text, 'failed', 'MODEL_QUOTA'));
};
import { companionPushTitleKey } from '../../../src/shared/contract/companionPush';

const port: NotificationPort = {
  permission: { read: async () => 'granted', request: async () => 'granted' },
  token: { current: async () => ({ kind: 'error', code: 'REGISTRATION_FAILED' }), subscribe: () => () => {} },
  tap: { subscribe: async () => () => {} },
  openSettings: async () => {},
  network: { read: () => 'online' },
};

function notifications(viewing: string | null, resolveRoute?: (token: string) => Promise<string | null>) {
  const resolve = resolveRoute ? vi.fn(resolveRoute) : undefined;
  const store = createNotificationStore({
    port,
    preference: { get: () => true, set: () => {} },
    session: {
      status: () => 'connected', register: async () => ({ kind: 'registered' }), unregister: async () => {},
      openRoute: async () => {}, reconnect: async () => {},
      viewing: () => viewing, ...(resolve ? { resolveRoute: resolve } : {}),
    },
  });
  return { store, resolve };
}

describe('前台推送：一律不弹系统横幅，改走 app 内提示（N-MOBILE-FOREGROUND-PUSH）', () => {
  it('正看着的就是推送那条会话 ⇒ 不弹也不出轻提示（N-MOBILE-EXEC-STATUS ④ 不退化）', async () => {
    const { store } = notifications('s1', async () => 's1');
    await expect(store.getState().decideForeground('rt')).resolves.toBe(false);
    expect(store.getState().foregroundAlert).toBeNull();
    expect(store.getState().unreadSessions).toEqual([]);
  });

  it('推送属于别的会话 ⇒ 不弹，轻提示带 sessionId、该会话进未读', async () => {
    const { store } = notifications('s1', async () => 's2');
    await expect(store.getState().decideForeground('rt')).resolves.toBe(false);
    expect(store.getState().foregroundAlert).toMatchObject({ routeToken: 'rt', sessionId: 's2' });
    expect(store.getState().unreadSessions).toEqual(['s2']);
  });

  it('不在会话页（欢迎页/抽屉/弹层盖着）⇒ 不弹，仍查归属给未读点上料', async () => {
    const { store, resolve } = notifications(null, async () => 's2');
    await expect(store.getState().decideForeground('rt')).resolves.toBe(false);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(store.getState().foregroundAlert).toMatchObject({ routeToken: 'rt', sessionId: 's2' });
    expect(store.getState().unreadSessions).toEqual(['s2']);
  });

  it('判不出属于哪条（查询失败 / 查不到 / 没 token / 不支持查询）⇒ 不弹，通用轻提示照出（新版不许吞）', async () => {
    // 没 token 那条用 routeToken=null（resolveRoute 存在也无从查起），轻提示照出、routeToken 原样保留。
    const unknown = async (store: ReturnType<typeof notifications>['store'], token: string | null) => {
      await expect(store.getState().decideForeground(token)).resolves.toBe(false);
      expect(store.getState().foregroundAlert).toMatchObject({ routeToken: token, sessionId: null });
      expect(store.getState().unreadSessions).toEqual([]);
    };
    await unknown(notifications('s1', async () => { throw new Error('offline'); }).store, 'rt');
    await unknown(notifications('s1', async () => null).store, 'rt');
    await unknown(notifications('s1', async () => 's1').store, null);
    await unknown(notifications('s1').store, 'rt');
  });

  it('判定一路都不许抛：viewing 崩了也按不弹结算并出通用轻提示', async () => {
    const store = createNotificationStore({
      port,
      preference: { get: () => true, set: () => {} },
      session: {
        status: () => 'connected', register: async () => ({ kind: 'registered' }), unregister: async () => {},
        openRoute: async () => {}, reconnect: async () => {},
        viewing: () => { throw new Error('boom'); }, resolveRoute: async () => 's2',
      },
    });
    await expect(store.getState().decideForeground('rt')).resolves.toBe(false);
    expect(store.getState().foregroundAlert).toMatchObject({ routeToken: 'rt', sessionId: null });
  });

  it('轻提示到点/点按收掉，未读点进会话即清', async () => {
    const { store } = notifications('s1', async () => 's2');
    await store.getState().decideForeground('rt');
    store.getState().dismissForegroundAlert();
    expect(store.getState().foregroundAlert).toBeNull();
    expect(store.getState().unreadSessions).toEqual(['s2']);
    store.getState().markSessionRead('s2');
    expect(store.getState().unreadSessions).toEqual([]);
  });
});

function pushBridge() {
  return {
    checkPermissions: async () => ({ receive: 'granted' }),
    requestPermissions: async () => ({ receive: 'granted' }),
    register: async () => {},
    addListener: async () => ({ remove: async () => {} }),
  };
}

function presentationBridge(enableFails = false) {
  const listeners: Array<(event: { id: string; routeToken?: string }) => void> = [];
  const remove = vi.fn(async () => {});
  return {
    remove,
    enable: vi.fn(async () => { if (enableFails) throw new Error('not implemented'); }),
    decide: vi.fn(async (_options: { id: string; present: boolean }) => {}),
    addListener: vi.fn(async (_event: 'willPresent', cb: (event: { id: string; routeToken?: string }) => void) => { listeners.push(cb); return { remove }; }),
    fire(event: { id: string; routeToken?: string }) { for (const cb of listeners) cb(event); },
  };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('iOS 前台判定接线：willPresent → decide', () => {
  it('JS 的判定原样回给插件', async () => {
    const presentation = presentationBridge();
    const notifyPort = createNotificationPort('ios', async () => {}, pushBridge() as never, presentation);
    await notifyPort.foreground!.subscribe(async token => token !== 'same-session');
    expect(presentation.enable).toHaveBeenCalledTimes(1);
    presentation.fire({ id: 'n1', routeToken: 'same-session' });
    presentation.fire({ id: 'n2', routeToken: 'other' });
    presentation.fire({ id: 'n3', routeToken: '' });
    await settle();
    expect(presentation.decide.mock.calls.map(([options]) => options)).toEqual([
      { id: 'n1', present: false }, { id: 'n2', present: true }, { id: 'n3', present: true },
    ]);
  });

  it('判定抛错按「弹」回话', async () => {
    const presentation = presentationBridge();
    const notifyPort = createNotificationPort('ios', async () => {}, pushBridge() as never, presentation);
    await notifyPort.foreground!.subscribe(async () => { throw new Error('boom'); });
    presentation.fire({ id: 'n1', routeToken: 'rt' });
    await settle();
    expect(presentation.decide).toHaveBeenCalledWith({ id: 'n1', present: true });
  });

  it('旧包里没有这个插件：订阅不抛（不把页面标成原生错误），监听收回', async () => {
    const presentation = presentationBridge(true);
    const notifyPort = createNotificationPort('ios', async () => {}, pushBridge() as never, presentation);
    await expect(notifyPort.foreground!.subscribe(async () => false)).resolves.toBeTypeOf('function');
    expect(presentation.remove).toHaveBeenCalledTimes(1);
  });

  it('非 iOS / 没注入插件时没有前台判定口', () => {
    expect(createNotificationPort('android').foreground).toBeUndefined();
    expect(createNotificationPort('ios', async () => {}, pushBridge() as never).foreground).toBeUndefined();
  });

  it('原生侧：超时与未订阅都照常弹，只有 JS 回 false 才吞；构建闸把类名和两张表查到产物里', () => {
    const swift = readFileSync('packages/mobile/ios-native/NeoPushPresentationPlugin.swift', 'utf8');
    expect(swift).toContain('UNUserNotificationCenter.current().delegate = self');
    expect(swift).toMatch(/asyncAfter\(deadline: \.now\(\) \+ Self\.decisionTimeout\) \{\s*self\.finish\(id, present: true\)/);
    expect(swift).toMatch(/guard isRemote, hasListeners\("willPresent"\) else \{\s*router\.userNotificationCenter/);
    expect(swift.match(/completionHandler\(\[\]\)/g)).toHaveLength(1);
    expect(swift).toMatch(/didReceive response[\s\S]*router\.userNotificationCenter\(center, didReceive: response/);
    const build = readFileSync('packages/mobile/scripts/build-ios.mjs', 'utf8');
    expect(build).toContain("nativeClass: 'NeoPushPresentationPlugin'");
    expect(build).toContain('IOS_PUSH_PRESENTATION_PLUGIN_MISSING_FROM_BINARY');
    expect(build).toContain('withLocalizableStrings(readFileSync(pbxproj');
    expect(build).toContain('IOS_PUSH_STRINGS_MISSING_FROM_BUNDLE');
  });
});

describe('推送正文走 i18n，不再是裸事件 key（N-MOBILE-EXEC-STATUS ⑤）', () => {
  const hostKeys = ['agent_complete', 'agent_cancelled', 'error'].map(kind => companionPushTitleKey(kind, {}))
    .concat(companionPushTitleKey('approval', { status: 'pending' }))
    .concat(companionPushTitleKey('error', { code: 'MODEL_AUTH' }))
    .concat(companionPushTitleKey('error', { code: 'MODEL_UNAVAILABLE' }))
    .concat(companionPushTitleKey('error', { code: 'MODEL_QUOTA' }));

  it.each(['zh', 'en'])('%s：Host 会发的每个 loc-key 都有人话正文', language => {
    const strings = pushAlertStrings(language);
    expect(Object.keys(strings).sort()).toEqual([...hostKeys].sort());
    for (const [key, value] of Object.entries(strings)) {
      expect(value.trim()).not.toBe('');
      expect(value).not.toBe(key);
      expect(value).not.toMatch(/^[a-z_]+$/);
    }
  });

  it('完成/失败说人话，失败带一句原因（与会话里那一行同一套文案）', () => {
    const zh = messages('zh');
    expect(pushAlertStrings('zh')).toMatchObject({ task_complete: zh.complete, task_failed: `${zh.failed}：${zh.runFailed}` });
    const en = messages('en');
    expect(pushAlertStrings('en')).toMatchObject({ task_complete: en.complete, task_failed: `${en.failed}: ${en.runFailed}` });
  });

  // 爸 2026-09-16 真机：模型 key 被拒，横幅却写「电脑执行时出了问题」
  it('模型密钥用不了的失败推送说真因，其余失败仍是通用句', () => {
    expect(companionPushTitleKey('error', { code: 'MODEL_AUTH' })).toBe('task_failed_model_auth');
    expect(companionPushTitleKey('error', { code: 'MODEL_UNAVAILABLE' })).toBe('task_failed_model_unavailable');
    expect(companionPushTitleKey('error', { code: 'RUN_FAILED' })).toBe('task_failed');
    const zh = messages('zh');
    expect(pushAlertStrings('zh').task_failed_model_auth).toBe(`${zh.failed}：${zh.modelAuthMissing}`);
    expect(pushAlertStrings('zh').task_failed_model_auth).not.toContain(zh.runFailed);
  });

  it('模型停用的推送正文必须显式传入：漏传直接抛，不再默认回落成密钥文案（ai-review PR#1918 Nit）', () => {
    const zh = messages('zh');
    // .d.mts 已把第 4 参定为必传，TS 侧漏传编译期就红；这里的断言模拟真实 JS 调用方
    // （build-ios.mjs 无类型）漏传时的运行时行为：直接抛，不是默默用密钥文案顶上。
    const jsCallerOmitsArg = mapPushAlerts as (text: Record<string, string>, failedLine: string, authLine: string) => Record<string, string>;
    expect(() => jsCallerOmitsArg(zh, runOutcomeCopy(zh, 'failed'), runOutcomeCopy(zh, 'failed', 'MODEL_AUTH')))
      .toThrow('IOS_PUSH_MODEL_UNAVAILABLE_LINE_REQUIRED');
    expect(pushAlertStrings('zh').task_failed_model_unavailable).toBe(`${zh.failed}：${zh.modelGoneLabel}`);
    expect(pushAlertStrings('zh').task_failed_model_unavailable).not.toContain(zh.modelAuthMissing);
  });

  // 模拟器验收 O2：余额不足的失败推送也说真因（用户能当场换模型），正文必须显式传入。
  it('余额或额度用完（MODEL_QUOTA）的推送说真因；漏传 quota 正文直接抛', () => {
    const zh = messages('zh');
    expect(companionPushTitleKey('error', { code: 'MODEL_QUOTA' })).toBe('task_failed_model_quota');
    expect(pushAlertStrings('zh').task_failed_model_quota).toBe(`${zh.failed}：${zh.modelQuotaExhausted}`);
    expect(pushAlertStrings('zh').task_failed_model_quota).not.toContain(zh.runFailed);
    expect(pushAlertStrings('zh').task_failed_model_quota).not.toContain(zh.modelAuthMissing);
    const en = messages('en');
    expect(pushAlertStrings('en').task_failed_model_quota).toBe(`${en.failed}: ${en.modelQuotaExhausted}`);
    // JS 调用方带了停用句但漏了 quota 句：直接抛，不许拿密钥/停用文案顶替
    const jsCallerOmitsQuota = mapPushAlerts as (text: Record<string, string>, failedLine: string, authLine: string, unavailableLine: string) => Record<string, string>;
    expect(() => jsCallerOmitsQuota(zh, runOutcomeCopy(zh, 'failed'), runOutcomeCopy(zh, 'failed', 'MODEL_AUTH'), runOutcomeCopy(zh, 'failed', 'MODEL_UNAVAILABLE')))
      .toThrow('IOS_PUSH_MODEL_QUOTA_LINE_REQUIRED');
  });

  it('.strings 转义引号、反斜杠、换行', () => {
    expect(localizableStrings({ a: 'x"y\\z\nw' })).toBe('"a" = "x\\"y\\\\z\\nw";\n');
  });

  const pbxproj = `/* Begin PBXBuildFile section */
\t\t504EC30D1FED79650016851F /* Main.storyboard in Resources */ = {isa = PBXBuildFile; fileRef = 504EC30B1FED79650016851F /* Main.storyboard */; };
/* End PBXBuildFile section */

/* Begin PBXFileReference section */
\t\t504EC30C1FED79650016851F /* Base */ = {isa = PBXFileReference; lastKnownFileType = file.storyboard; name = Base; path = Base.lproj/Main.storyboard; sourceTree = "<group>"; };
/* End PBXFileReference section */

/* Begin PBXGroup section */
\t\t504EC3061FED79650016851F /* App */ = {
\t\t\tisa = PBXGroup;
\t\t\tchildren = (
\t\t\t\t504EC30B1FED79650016851F /* Main.storyboard */,
\t\t\t);
\t\t};
/* End PBXGroup section */

/* Begin PBXProject section */
\t\t\tknownRegions = (
\t\t\t\ten,
\t\t\t\tBase,
\t\t\t);
/* End PBXProject section */

/* Begin PBXResourcesBuildPhase section */
\t\t504EC3021FED79650016851F /* Resources */ = {
\t\t\tisa = PBXResourcesBuildPhase;
\t\t\tfiles = (
\t\t\t\t504EC30D1FED79650016851F /* Main.storyboard in Resources */,
\t\t\t);
\t\t};
/* End PBXResourcesBuildPhase section */

/* Begin PBXVariantGroup section */
\t\t504EC30B1FED79650016851F /* Main.storyboard */ = {
\t\t\tisa = PBXVariantGroup;
\t\t\tchildren = (
\t\t\t\t504EC30C1FED79650016851F /* Base */,
\t\t\t);
\t\t\tname = Main.storyboard;
\t\t\tsourceTree = "<group>";
\t\t};
/* End PBXVariantGroup section */`;

  it('Localizable.strings 挂进 App 组、Resources 阶段与 VariantGroup，补 zh-Hans 区；幂等', () => {
    const patched = withLocalizableStrings(pbxproj);
    const group = patched.slice(patched.indexOf('/* Begin PBXGroup section */'), patched.indexOf('/* End PBXGroup section */'));
    const resources = patched.slice(patched.indexOf('isa = PBXResourcesBuildPhase;'), patched.indexOf('/* End PBXResourcesBuildPhase section */'));
    const variants = patched.slice(patched.indexOf('/* Begin PBXVariantGroup section */'));
    expect(group).toContain('/* Localizable.strings */,');
    expect(resources).toContain('/* Localizable.strings in Resources */,');
    for (const [region] of LOCALIZABLE_REGIONS) {
      expect(patched).toContain(`path = ${region}.lproj/Localizable.strings;`);
      expect(variants).toContain(`/* ${region} */,`);
    }
    expect(variants).toContain('name = Localizable.strings;');
    expect(patched).toMatch(/knownRegions = \(\n\t+en,\n\t+Base,\n\t+"zh-Hans",\n\t+\);/);
    expect(withLocalizableStrings(patched)).toBe(patched);
  });

  it('模板形状变了（锚点缺失）就停，不带着半截工程去签包', () => {
    expect(() => withLocalizableStrings(pbxproj.replace('isa = PBXResourcesBuildPhase;', ''))).toThrow('IOS_LOCALIZABLE_UNPATCHABLE');
    expect(() => withLocalizableStrings(pbxproj.replace(/knownRegions[\s\S]*?\);/, ''))).toThrow('IOS_LOCALIZABLE_UNPATCHABLE');
  });
});
