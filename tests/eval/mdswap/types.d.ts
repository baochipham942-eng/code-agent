import type { MarkdownFixture } from './fixtures';

declare global {
  interface Window {
    mdswap: {
      fixtures: MarkdownFixture[];
      render(request: { side: 'neo' | 'streamdown'; content: string; phase: 'active' | 'complete' | 'static' }): Promise<void>;
    };
  }
}

export {};
