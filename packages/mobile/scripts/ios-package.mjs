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
