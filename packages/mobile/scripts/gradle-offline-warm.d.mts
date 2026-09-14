export const OFFLINE_ASSEMBLE_ARGS: readonly string[];
export const ONLINE_RESOLVE_ARGS: readonly string[];

export declare function gradleErrorText(error: unknown): string;
export declare function isGradleCacheMiss(text: string): boolean;
export declare function assembleDebugOffline(options?: {
  gradle?: string;
  cwd?: string;
  exec?: (command: string, args: readonly string[], cwd?: string) => string;
  log?: (message: string) => void;
}): { warmed: boolean };
