import type { FileCache } from './fileCache';
import type { HistoryCache } from './historyCache';
import type { RelayDialSocket } from './relayCompanionClient';

type Dispose = () => void;

type KeyboardFrame = { height: number; phase: 'will-show' | 'will-hide' };

export interface PickedFile {
  name: string;
  mimeType: string;
  size: number;
  bytes: Uint8Array;
}

interface FileExportResult {
  status: 'saved' | 'cancelled' | 'error';
  code?: string;
  /** 实际落盘文件名（同名去重后可能与请求名不同）。 */
  name?: string;
}

export interface FilePorts {
  pick(kind: 'image' | 'file' | 'camera'): Promise<PickedFile | null>;
  save(file: { name: string; mimeType: string; bytes: Uint8Array }): Promise<FileExportResult>;
  cache: FileCache;
}

export type OsPermission = 'unknown' | 'requesting' | 'granted' | 'limited' | 'denied' | 'restricted';
export type NetworkStatus = 'unknown' | 'online' | 'offline';
type PushProvider = 'apns' | 'fcm' | 'vendor';
export type PushToken = { provider: PushProvider; token: string; environment: 'production' | 'sandbox' };
export type TokenResult =
  | { kind: 'token'; token: PushToken }
  | { kind: 'unavailable'; code: 'CHANNEL_MISSING'; missing: 'apns_entitlement' | 'gms_or_vendor' }
  | { kind: 'error'; code: 'REGISTRATION_FAILED' };

export interface NotificationPort {
  permission: { read(): Promise<OsPermission>; request(): Promise<OsPermission> };
  token: { current(): Promise<TokenResult>; subscribe(onChange: (result: TokenResult) => void): Dispose };
  tap: { subscribe(onTap: (routeToken: string) => void): Promise<Dispose> };
  /** 前台来推送时问一句要不要弹（decide 回 false = 不弹）；只有 iOS 第一方插件提供。 */
  foreground?: { subscribe(decide: (routeToken: string | null) => Promise<boolean>): Promise<Dispose> };
  openSettings(): Promise<void>;
  network: { read(): NetworkStatus };
}

export interface PlatformPorts {
  recorder?: {
    start(): Promise<void>;
    stop(): Promise<{ audioData: string; mimeType: string; durationMs: number }>;
    startPcm?(): Promise<{ sampleRate: number }>;
    stopPcm?(): Promise<void>;
    subscribePcm?(onFrame: (frame: { pcm: string; durationMs: number }) => void): () => void;
  };
  companion?: {
    read(): Promise<string | null>; write(value: string): Promise<void>;
    scan(): Promise<string>; post(url: string, body: unknown): Promise<unknown>;
    /** One-shot mDNS resolve of a `.local` hostname to a private IPv4 (fix4-⑤). Null = use the old address. */
    resolveHost?(host: string): Promise<string | null>;
    /**
     * 拨 relay WSS（N-MOBILE-RELAY-PHONE）。headers 由能设头的运行时消费；WebView 的
     * WebSocket 设不了头，部署侧前置层注入凭据。缺省走 browserRelayDial。
     */
    dialRelay?(url: string, headers: { authorization: string }): RelayDialSocket;
  };
  files?: FilePorts;
  /** App-private conversation body cache. Separate from pairing identity and drafts. */
  historyCache?: HistoryCache;
  notifications?: NotificationPort;
  preferences: { get(): Promise<string | null>; set(value: string): Promise<void> };
  appInfo: { read(): Promise<{ version: string; build: string }> };
  lifecycle: { subscribe(onActive: (active: boolean) => void, onBack: () => void): Promise<Dispose>; leave(): Promise<void> };
  keyboard: {
    subscribe(onVisible: (visible: boolean) => void): Promise<Dispose>;
    subscribeFrame(onFrame: (frame: KeyboardFrame) => void): Promise<Dispose>;
    hide(): Promise<void>;
  };
  systemBars?: { setStyle(appearance: 'light' | 'dark'): Promise<void> };
}
