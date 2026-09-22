// Pure helpers shared by build-ios.mjs and ios-verify.mjs, and covered by
// tests/unit/mobile/iosPackage.test.ts. No remote-only gate here: the unit
// tests import this module directly.

export function extractPlistXml(buffer) {
  const text = buffer.toString('latin1');
  const start = text.indexOf('<?xml');
  const end = text.indexOf('</plist>');
  if (start < 0 || end < 0) throw new Error('MOBILEPROVISION_PLIST_MISSING');
  return text.slice(start, end + '</plist>'.length);
}

export function parsePlistXml(xml) {
  let index = 0;
  const skipWhitespace = () => { while (index < xml.length && /\s/.test(xml[index])) index++; };
  const readTag = name => {
    skipWhitespace();
    const open = `<${name}>`;
    if (!xml.startsWith(open, index)) throw new Error(`PLIST_EXPECTED_${name.toUpperCase()}_AT_${index}`);
    index += open.length;
    const end = xml.indexOf(`</${name}>`, index);
    if (end < 0) throw new Error(`PLIST_UNTERMINATED_${name.toUpperCase()}`);
    const text = xml.slice(index, end);
    index = end + name.length + 3;
    return text;
  };
  const parseValue = () => {
    skipWhitespace();
    for (const [name, convert] of [['string', text => text], ['integer', text => Number(text)],
      ['real', text => Number(text)], ['date', text => new Date(text)], ['data', text => text]]) {
      if (xml.startsWith(`<${name}>`, index)) return convert(readTag(name));
    }
    if (xml.startsWith('<array>', index)) {
      index += 7;
      const values = [];
      for (;;) {
        skipWhitespace();
        if (xml.startsWith('</array>', index)) { index += 8; return values; }
        values.push(parseValue());
      }
    }
    if (xml.startsWith('<dict>', index)) {
      index += 6;
      const dict = {};
      for (;;) {
        skipWhitespace();
        if (xml.startsWith('</dict>', index)) { index += 7; return dict; }
        const key = readTag('key');
        dict[key] = parseValue();
      }
    }
    if (xml.startsWith('<true/>', index)) { index += 7; return true; }
    if (xml.startsWith('<false/>', index)) { index += 8; return false; }
    throw new Error(`PLIST_UNEXPECTED_TOKEN_AT_${index}`);
  };
  skipWhitespace();
  if (xml.startsWith('<?xml', index)) index = xml.indexOf('?>', index) + 2;
  skipWhitespace();
  if (xml.startsWith('<!DOCTYPE', index)) index = xml.indexOf('>', index) + 1;
  skipWhitespace();
  if (!xml.startsWith('<plist', index)) throw new Error(`PLIST_WRAPPER_MISSING_AT_${index}`);
  index = xml.indexOf('>', index) + 1;
  return parseValue();
}

export function readMobileprovision(buffer) {
  return parsePlistXml(extractPlistXml(buffer));
}

const dateOrNull = value => value instanceof Date && !Number.isNaN(value.getTime()) ? value : null;
const stringOrNull = value => typeof value === 'string' ? value : null;

export function summarizeProfile(plist, now = new Date()) {
  const entitlements = plist.Entitlements ?? {};
  const devices = Array.isArray(plist.ProvisionedDevices) ? plist.ProvisionedDevices : [];
  const teamIdentifier = Array.isArray(plist.TeamIdentifier) ? plist.TeamIdentifier : [];
  const expiresAt = dateOrNull(plist.ExpirationDate);
  return {
    name: stringOrNull(plist.Name),
    uuid: stringOrNull(plist.UUID),
    teamName: stringOrNull(plist.TeamName),
    teamIdentifier,
    createdAt: dateOrNull(plist.CreationDate),
    expiresAt,
    expired: expiresAt !== null && expiresAt.getTime() <= now.getTime(),
    method: devices.length > 0 ? (entitlements['get-task-allow'] === true ? 'development' : 'ad-hoc') : 'app-store',
    provisionedDeviceCount: devices.length,
    apsEnvironment: stringOrNull(entitlements['aps-environment']),
  };
}

/** MI-03: missing aps-environment is a failed check, not a silent empty field. */
export function assertPushEntitlement(summary) {
  if (summary.apsEnvironment !== 'production' && summary.apsEnvironment !== 'development') {
    throw new Error('PUSH_ENTITLEMENT_MISSING');
  }
  return summary.apsEnvironment;
}

export function profileCoversDevice(plist, udid) {
  const devices = Array.isArray(plist.ProvisionedDevices) ? plist.ProvisionedDevices : [];
  return devices.includes(udid);
}

export function patchPbxprojVersions(content, version, build) {
  if (!/CURRENT_PROJECT_VERSION = \d+;/.test(content) || !/MARKETING_VERSION = [\d.]+;/.test(content)) {
    throw new Error('IOS_TEMPLATE_CHANGED');
  }
  return content.replace(/CURRENT_PROJECT_VERSION = \d+;/g, `CURRENT_PROJECT_VERSION = ${build};`)
    .replace(/MARKETING_VERSION = [\d.]+;/g, `MARKETING_VERSION = ${version};`);
}

export function extractNativeTargetId(content) {
  const match = content.match(/^\s*([0-9A-F]+) \/\* App \*\/ = \{\n\s*isa = PBXNativeTarget;/m);
  if (!match) throw new Error('IOS_TEMPLATE_CHANGED');
  return match[1];
}

export function sharedSchemeXml(targetId) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="1600" version="1.7" buildImplicitDependencies="YES">
    <BuildAction parallelizableBuildables="YES" buildImplicitDependencies="YES">
        <BuildActionEntries>
            <BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">
                <BuildableReference BuildableIdentifier = "primary" BlueprintIdentifier = "${targetId}" BuildableName = "App.app" BlueprintName = "App" ReferencedContainer = "container:App.xcodeproj">
                </BuildableReference>
            </BuildActionEntry>
        </BuildActionEntries>
    </BuildAction>
    <ArchiveAction buildConfiguration = "Release" customArchiveName = "App" revealArchiveInOrganizer = "YES">
    </ArchiveAction>
</Scheme>
`;
}

export function exportOptionsXml({ method, teamId, style, appId, profileName, identity }) {
  const entries = [
    ['method', method],
    ['teamID', teamId],
    ['signingStyle', style],
    ['destination', 'export'],
    ['compileBitcode', false],
    ['stripSwiftSymbols', true],
  ];
  if (style === 'manual') {
    entries.push(['signingCertificate', identity]);
    entries.push(['provisioningProfiles', { [appId]: profileName }]);
  }
  const xmlEscape = text => String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
  const render = value => {
    if (typeof value === 'boolean') return value ? '<true/>' : '<false/>';
    if (typeof value === 'object' && value !== null) {
      return `<dict>${Object.entries(value).map(([key, nested]) => `<key>${xmlEscape(key)}</key>${render(nested)}`).join('')}</dict>`;
    }
    return `<string>${xmlEscape(value)}</string>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>${entries.map(([key, value]) => `<key>${key}</key>${render(value)}`).join('')}</dict>
</plist>
`;
}

/**
 * SPM 工程里，没有 `Package.swift` 的 Capacitor 插件会被 `cap sync ios` 排除在
 * `CapApp-SPM/Package.swift` 之外——它只打一行 warn，构建照常成功，原生类却不在二进制里，
 * 运行时才报 "plugin is not implemented on ios"（FB-140 真机实测，这条 warn 之前每次构建都印、没人看）。
 * 这里把「装了的插件」和「真正链进去的插件」对一遍，对不上就让构建失败。
 * selfImplemented 是我们自己写了原生实现、故意不走厂商包的插件（见 ios-native/）。
 */
export function unlinkedSpmPlugins(packageSwift, plugins, selfImplemented = []) {
  const own = new Set(selfImplemented);
  return plugins.filter((name) => !own.has(name) && !packageSwift.includes(`node_modules/${name}"`));
}

/**
 * Capacitor 8 不扫描 CAPBridgedPlugin，而是读 ios/App/App/capacitor.config.json 的
 * packageClassList，逐个按类名找类（找不到就静默跳过）。cap sync 生成这张表时会把**厂商**插件的
 * ObjC 类名写进去——即便那个包因为没有 Package.swift 根本不会被编译。于是「类进了二进制」
 * 与「Capacitor 会注册它」是两回事：自己实现的插件必须把登记名换成第一方类名，否则
 * 运行时照旧是 plugin is not implemented on ios（ai-review PR#1760 Important 1，已用真机
 * 生成的 capacitor.config.json 与 Capacitor.framework 里的 packageClassList / autoRegisterPlugins 核实）。
 */
/** 推送正文本地化的两个区：lproj 目录名 → i18n 语言（N-MOBILE-EXEC-STATUS ⑤）。 */
export const LOCALIZABLE_REGIONS = [['en', 'en'], ['zh-Hans', 'zh']];

/**
 * 推送横幅正文（N-MOBILE-EXEC-STATUS ⑤）。Host 只发 APNs 的 loc-key（= titleKey），iOS 在 app 包里的
 * Localizable.strings 查正文；包里没有这张表时系统把 key 原样当正文——build 40 真机横幅写着 task_complete。
 * 文案全部取自 src/i18n（text 与 failedLine 由 build-ios 传入），这里只把 Host 的 titleKey 对到文案上。
 * 只有构建脚本用，所以放脚本侧，不从 i18n 导出。推送里不带失败码，失败只能给通用原因；唯一例外是模型密钥用不了、
 * 模型停用与余额额度用完，Host 发单独的 task_failed_model_auth / task_failed_model_unavailable /
 * task_failed_model_quota（用户能当场换模型，横幅不该把原因藏起来）。modelUnavailableFailedLine /
 * modelQuotaFailedLine 必传：默认回落密钥文案会把「模型停用/余额用完」错说成「密钥用不了」。
 */
export function pushAlertStrings(text, failedLine, modelAuthFailedLine, modelUnavailableFailedLine, modelQuotaFailedLine) {
  if (typeof modelUnavailableFailedLine !== 'string' || modelUnavailableFailedLine.trim() === '') {
    throw new Error('IOS_PUSH_MODEL_UNAVAILABLE_LINE_REQUIRED');
  }
  if (typeof modelQuotaFailedLine !== 'string' || modelQuotaFailedLine.trim() === '') {
    throw new Error('IOS_PUSH_MODEL_QUOTA_LINE_REQUIRED');
  }
  return {
    task_complete: text.complete,
    task_stopped: text.stopped,
    task_failed: failedLine,
    task_failed_model_auth: modelAuthFailedLine,
    task_failed_model_unavailable: modelUnavailableFailedLine,
    task_failed_model_quota: modelQuotaFailedLine,
    approval_needed: text.approval,
  };
}

/** Apple .strings 表：每行 "key" = "value";，引号、反斜杠、换行转义。 */
export function localizableStrings(entries) {
  const quote = value => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
  return `${Object.entries(entries).map(([key, value]) => `${quote(key)} = ${quote(value)};`).join('\n')}\n`;
}

/**
 * 把 Localizable.strings 挂进 App target 的 Resources（Capacitor 模板里没有这张表，APNs 的 loc-key
 * 查不到就把 key 原样当横幅正文）。照模板里 Main.storyboard 的形状写一个 PBXVariantGroup，
 * knownRegions 补上缺的区。锚点缺一个就停，不带着半截工程去签包。幂等。
 */
export function withLocalizableStrings(content) {
  if (content.includes('/* Localizable.strings in Resources */')) return content;
  const buildId = 'A1B2C3D4E5F6070809000001';
  const groupId = 'A1B2C3D4E5F6070809000002';
  const refs = LOCALIZABLE_REGIONS.map(([region], index) => ({ region, id: `A1B2C3D4E5F607080900001${index}` }));
  const at = (source, anchor, from = 0) => {
    const found = from < 0 ? -1 : source.indexOf(anchor, from);
    if (found < 0) throw new Error(`IOS_LOCALIZABLE_UNPATCHABLE: ${anchor.trim()}`);
    return found + anchor.length;
  };
  const insert = (source, index, text) => `${source.slice(0, index)}${text}${source.slice(index)}`;
  let out = content;
  out = insert(out, at(out, '/* Begin PBXBuildFile section */\n'),
    `\t\t${buildId} /* Localizable.strings in Resources */ = {isa = PBXBuildFile; fileRef = ${groupId} /* Localizable.strings */; };\n`);
  out = insert(out, at(out, '/* Begin PBXFileReference section */\n'), refs.map(({ region, id }) =>
    `\t\t${id} /* ${region} */ = {isa = PBXFileReference; lastKnownFileType = text.plist.strings; name = ${region}; path = ${region}.lproj/Localizable.strings; sourceTree = "<group>"; };\n`).join(''));
  // App 组：与模板里的 Main.storyboard 同组（PBXGroup 段里它是组的一个子项）
  out = insert(out, at(out, '/* Main.storyboard */,\n', out.indexOf('/* Begin PBXGroup section */')),
    `\t\t\t\t${groupId} /* Localizable.strings */,\n`);
  out = insert(out, at(out, 'files = (\n', out.indexOf('isa = PBXResourcesBuildPhase;')),
    `\t\t\t\t${buildId} /* Localizable.strings in Resources */,\n`);
  const variantEnd = at(out, '/* End PBXVariantGroup section */') - '/* End PBXVariantGroup section */'.length;
  out = insert(out, variantEnd, `\t\t${groupId} /* Localizable.strings */ = {\n\t\t\tisa = PBXVariantGroup;\n\t\t\tchildren = (\n${
    refs.map(({ region, id }) => `\t\t\t\t${id} /* ${region} */,\n`).join('')}\t\t\t);\n\t\t\tname = Localizable.strings;\n\t\t\tsourceTree = "<group>";\n\t\t};\n`);
  let regionsPatched = false;
  out = out.replace(/(knownRegions = \()([\s\S]*?)(\n\s*\);)/, (_block, open, regions, close) => {
    regionsPatched = true;
    const missing = LOCALIZABLE_REGIONS.map(([region]) => region)
      .filter(region => !new RegExp(`^\\s*"?${region}"?,$`, 'm').test(regions));
    return `${open}${regions}${missing.map(region => `\n\t\t\t\t"${region}",`).join('')}${close}`;
  });
  if (!regionsPatched) throw new Error('IOS_LOCALIZABLE_UNPATCHABLE: knownRegions');
  return out;
}

/**
 * Capacitor's default AppDelegate does not forward APNs device tokens. Without these
 * two posts, register() resolves and then the plugin never emits `registration`.
 */
export function withPushAppDelegateHooks(source) {
  if (!source.includes('class AppDelegate') || !source.includes('import Capacitor')) {
    throw new Error('IOS_APP_DELEGATE_MISSING');
  }
  if (source.includes('capacitorDidRegisterForRemoteNotifications')
    && source.includes('capacitorDidFailToRegisterForRemoteNotifications')) {
    return source;
  }
  const closing = source.lastIndexOf('}');
  if (closing < 0) throw new Error('IOS_APP_DELEGATE_UNPATCHABLE');
  const hooks = `
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
      NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
      NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

`;
  return `${source.slice(0, closing)}${hooks}${source.slice(closing)}`;
}

export function withApsEnvironment(xml, environment) {
  if (environment !== 'production' && environment !== 'development') throw new Error('IOS_APS_ENVIRONMENT_INVALID');
  if (!xml.includes('<dict>')) throw new Error('IOS_ENTITLEMENTS_UNPATCHABLE');
  if (xml.includes('<key>aps-environment</key>')) {
    return xml.replace(
      /<key>aps-environment<\/key>\s*<string>[^<]*<\/string>/,
      `<key>aps-environment</key>\n\t<string>${environment}</string>`,
    );
  }
  return xml.replace('<dict>', `<dict>\n\t<key>aps-environment</key>\n\t<string>${environment}</string>`);
}

/** Capacitor's ios template has no App.entitlements; profile aps-environment is not a binary declaration. */
export function appEntitlementsXml(environment) {
  if (environment !== 'production' && environment !== 'development') throw new Error('IOS_APS_ENVIRONMENT_INVALID');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>aps-environment</key>
	<string>${environment}</string>
</dict>
</plist>
`;
}

/**
 * CODE_SIGN_ENTITLEMENTS on the App target (the two configs that stamp PRODUCT_BUNDLE_IDENTIFIER).
 * Project-level configs are left alone. Repeat calls replace the same assignment; they do not stack.
 */
export function withCodeSignEntitlements(content, { relativePath, appId }) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('..') || /[\n;]/.test(relativePath)) {
    throw new Error('IOS_ENTITLEMENTS_PATH_INVALID');
  }
  if (typeof appId !== 'string' || !appId) throw new Error('IOS_ENTITLEMENTS_PATH_INVALID');
  const assignment = `CODE_SIGN_ENTITLEMENTS = ${relativePath};`;
  let appConfigurations = 0;
  const next = content.replace(/buildSettings = \{([\s\S]*?)\n(\s*)\};/g, (block, settings, indent) => {
    if (!settings.includes(`PRODUCT_BUNDLE_IDENTIFIER = ${appId};`)) return block;
    appConfigurations += 1;
    if (/CODE_SIGN_ENTITLEMENTS = [^;]*;/.test(settings)) {
      settings = settings.replace(/CODE_SIGN_ENTITLEMENTS = [^;]*;/g, assignment);
    } else {
      settings = `${settings}\n${indent}\t${assignment}`;
    }
    return `buildSettings = {${settings}\n${indent}};`;
  });
  if (appConfigurations !== 2) throw new Error('IOS_APP_ENTITLEMENTS_CONFIGURATIONS_CHANGED');
  return next;
}

export function ensureAppPushEntitlements({ existingXml = null, pbxproj, environment, appId, relativePath = 'App/App.entitlements' }) {
  const entitlementsXml = withApsEnvironment(existingXml || appEntitlementsXml(environment), environment);
  return { entitlementsXml, pbxproj: withCodeSignEntitlements(pbxproj, { relativePath, appId }) };
}

/**
 * codesign -d --entitlements :- dumps XML on stdout (sometimes after an Executable= line or a binary prefix).
 * Profile entitlements are a different file; this parser is only for the signed binary dump.
 */
export function parseEntitlementsDump(dump) {
  const text = Buffer.isBuffer(dump) ? dump.toString('utf8') : String(dump);
  const xmlStart = text.indexOf('<?xml');
  const plistStart = text.indexOf('<plist');
  const start = xmlStart >= 0 ? xmlStart : plistStart;
  if (start < 0) throw new Error('IOS_BINARY_ENTITLEMENTS_UNREADABLE');
  const parsed = parsePlistXml(text.slice(start));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('IOS_BINARY_ENTITLEMENTS_UNREADABLE');
  }
  return { apsEnvironment: stringOrNull(parsed['aps-environment']) };
}

export function assertBinaryPushEntitlement(dump) {
  const summary = parseEntitlementsDump(dump);
  if (summary.apsEnvironment !== 'production' && summary.apsEnvironment !== 'development') {
    throw new Error('IOS_BINARY_APS_ENVIRONMENT_MISSING');
  }
  return summary.apsEnvironment;
}

export function withSelfImplementedPluginClasses(config, replacements) {
  // 形状不对就停：静默当成空表会把其余插件的登记一起丢掉，而那是整包功能级的静默损坏。
  if (!Array.isArray(config.packageClassList)) throw new Error('IOS_PACKAGE_CLASS_LIST_MISSING');
  const list = [...config.packageClassList];
  for (const { vendorClass, nativeClass } of replacements) {
    const at = list.indexOf(vendorClass);
    if (at >= 0) list.splice(at, 1, nativeClass);
    else if (!list.includes(nativeClass)) list.push(nativeClass);
  }
  return { ...config, packageClassList: list };
}
