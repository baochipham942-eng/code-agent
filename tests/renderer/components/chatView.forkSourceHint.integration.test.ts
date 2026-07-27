import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('ChatView compact fork source integration', () => {
  it('removes the top lineage toolbar and injects the source hint into the first transcript turn', () => {
    const chatView = fs.readFileSync(
      path.resolve(process.cwd(), 'src/renderer/components/ChatView.tsx'),
      'utf8',
    );
    const traceView = fs.readFileSync(
      path.resolve(process.cwd(), 'src/renderer/components/features/chat/TurnBasedTraceView.tsx'),
      'utf8',
    );

    expect(chatView).not.toContain('ForkLineageBar');
    expect(chatView).toContain('ForkSourceHint');
    expect(chatView).toMatch(/beforeFirstUserMessage=\{[\s\S]*ForkSourceHint/);
    expect(traceView).toContain(
      'beforeUserMessage={index === 0 ? beforeFirstUserMessage : undefined}',
    );
  });
});
