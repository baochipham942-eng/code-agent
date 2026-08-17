import { fixtures as mdswapFixtures } from '../mdswap/fixtures';

function fixture(id: string): string {
  const found = mdswapFixtures.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`missing mdswap fixture: ${id}`);
  return found.content;
}

export const pacingFixtures = [
  {
    id: 'long-mixed-code',
    label: '长代码流式',
    content: fixture('long-mixed-code'),
    chunkSize: 40,
    intervalMs: 30,
  },
  {
    id: 'long-mixed-prose',
    label: '长散文',
    content: fixture('long-mixed-prose'),
    chunkSize: 40,
    intervalMs: 30,
  },
  {
    id: 'high-frequency-small-chunk',
    label: '高频小 chunk（5 字符/30ms）',
    content: fixture('cjk-mixed-long-paragraph').repeat(3),
    chunkSize: 5,
    intervalMs: 30,
  },
] as const;
