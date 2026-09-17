export declare function extractPlistXml(buffer: Buffer): string;
export declare function parsePlistXml(xml: string): unknown;
export declare function readMobileprovision(buffer: Buffer): Record<string, unknown>;
export interface ProfileSummary {
  name: string | null;
  uuid: string | null;
  teamName: string | null;
  teamIdentifier: string[];
  createdAt: Date | null;
  expiresAt: Date | null;
  expired: boolean;
  method: 'ad-hoc' | 'development' | 'app-store';
  provisionedDeviceCount: number;
  apsEnvironment: string | null;
}
export declare function summarizeProfile(plist: Record<string, unknown>, now?: Date): ProfileSummary;
export declare function assertPushEntitlement(summary: Pick<ProfileSummary, 'apsEnvironment'>): string;
export declare function profileCoversDevice(plist: Record<string, unknown>, udid: string): boolean;
export declare function patchPbxprojVersions(content: string, version: string, build: number): string;
export declare function extractNativeTargetId(content: string): string;
export declare function sharedSchemeXml(targetId: string): string;
export interface ExportOptions {
  method: string;
  teamId: string;
  style: 'automatic' | 'manual';
  appId: string;
  profileName: string | null;
  identity: string | null;
}
export declare function exportOptionsXml(options: ExportOptions): string;

/** 装了的 iOS 插件里，哪些没被 cap sync 链进 CapApp-SPM/Package.swift（selfImplemented 除外）。 */
export function unlinkedSpmPlugins(packageSwift: string, plugins: string[], selfImplemented?: string[]): string[];
export function withPushAppDelegateHooks(source: string): string;
export function withApsEnvironment(xml: string, environment: 'production' | 'development'): string;
export function appEntitlementsXml(environment: 'production' | 'development'): string;
export function withCodeSignEntitlements(content: string, options: { relativePath: string; appId: string }): string;
export function ensureAppPushEntitlements(options: {
  existingXml?: string | null;
  pbxproj: string;
  environment: 'production' | 'development';
  appId: string;
  relativePath?: string;
}): { entitlementsXml: string; pbxproj: string };
export function parseEntitlementsDump(dump: string | Buffer): { apsEnvironment: string | null };
export function assertBinaryPushEntitlement(dump: string | Buffer): string;

/** Host 推送 titleKey → i18n 文案；按 titleKey 全集定型，Host 新增一种推送而这里没跟上时 typecheck 红。 */
export declare function pushAlertStrings(
  text: { complete: string; stopped: string; approval: string }, failedLine: string, modelAuthFailedLine: string,
  modelUnavailableFailedLine?: string,
): Record<import('../../../src/shared/contract/companionPush').CompanionPushTitleKey, string>;
/** 推送正文本地化的区：[lproj 目录名, i18n 语言]。 */
export declare const LOCALIZABLE_REGIONS: [string, string][];
export declare function localizableStrings(entries: Record<string, string>): string;
/** 把 Localizable.strings 挂进 App target 的 Resources，幂等；锚点缺失抛 IOS_LOCALIZABLE_UNPATCHABLE。 */
export declare function withLocalizableStrings(content: string): string;

export interface SelfImplementedPluginClass { vendorClass: string; nativeClass: string }
/** 把 packageClassList 里厂商插件的登记名换成第一方类名（Capacitor 按这张表 NSClassFromString）。 */
export declare function withSelfImplementedPluginClasses<T extends object>(
  config: T, replacements: SelfImplementedPluginClass[]): T & { packageClassList: string[] };
