import type { FileCache } from './fileCache';

export type Dispose = () => void;

export interface PickedFile {
  name: string;
  mimeType: string;
  size: number;
  bytes: Uint8Array;
}

export interface FileExportResult {
  status: 'saved' | 'cancelled' | 'error';
  code?: string;
  /** 实际落盘文件名（同名去重后可能与请求名不同）。 */
  name?: string;
}

export interface FilePorts {
  pick(kind: 'image' | 'file'): Promise<PickedFile | null>;
  save(file: { name: string; mimeType: string; bytes: Uint8Array }): Promise<FileExportResult>;
  cache: FileCache;
}

export interface PlatformPorts {
  recorder?: { start(): Promise<void>; stop(): Promise<{ audioData: string; mimeType: string; durationMs: number }>; };
  companion?: {
    read(): Promise<string | null>; write(value: string): Promise<void>;
    scan(): Promise<string>; post(url: string, body: unknown): Promise<unknown>;
  };
  files?: FilePorts;
  preferences: { get(): Promise<string | null>; set(value: string): Promise<void> };
  appInfo: { read(): Promise<{ version: string; build: string }> };
  lifecycle: { subscribe(onActive: (active: boolean) => void, onBack: () => void): Promise<Dispose>; leave(): Promise<void> };
  keyboard: { subscribe(onVisible: (visible: boolean) => void): Promise<Dispose>; hide(): Promise<void> };
  systemBars?: { setStyle(appearance: 'light' | 'dark'): Promise<void> };
}
