declare module '@pacing/convex-smooth' {
  export interface SmoothTextOptions {
    charsPerSec?: number;
    startStreaming?: boolean;
  }

  export function useSmoothText(
    text: string,
    options?: SmoothTextOptions,
  ): [string, { cursor: number; isStreaming: boolean }];
}
