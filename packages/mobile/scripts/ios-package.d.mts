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

export interface SelfImplementedPluginClass { vendorClass: string; nativeClass: string }
/** 把 packageClassList 里厂商插件的登记名换成第一方类名（Capacitor 按这张表 NSClassFromString）。 */
export declare function withSelfImplementedPluginClasses<T extends object>(
  config: T, replacements: SelfImplementedPluginClass[]): T & { packageClassList: string[] };
