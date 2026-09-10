export type Dispose = () => void;

export interface PlatformPorts {
  recorder?: { start(): Promise<void>; stop(): Promise<{ audioData: string; mimeType: string; durationMs: number }>; };
  companion?: {
    read(): Promise<string | null>; write(value: string): Promise<void>;
    scan(): Promise<string>; post(url: string, body: unknown): Promise<unknown>;
  };
  preferences: { get(): Promise<string | null>; set(value: string): Promise<void> };
  appInfo: { read(): Promise<{ version: string; build: string }> };
  lifecycle: { subscribe(onActive: (active: boolean) => void, onBack: () => void): Promise<Dispose>; leave(): Promise<void> };
  keyboard: { subscribe(onVisible: (visible: boolean) => void): Promise<Dispose>; hide(): Promise<void> };
  systemBars: { setStyle(appearance: 'light' | 'dark'): Promise<void> };
}
