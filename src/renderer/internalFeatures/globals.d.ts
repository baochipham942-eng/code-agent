import type { INTERNAL_RENDERER_SDK } from './internalSdk';

declare global {
  interface Window {
    __NEO_INTERNAL_SDK__?: typeof INTERNAL_RENDERER_SDK;
  }
}

export {};
