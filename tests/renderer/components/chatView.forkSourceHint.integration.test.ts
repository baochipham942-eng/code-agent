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
    // 这个元素必须是 memo 出来的、不能内联新建：它是 TurnBasedTraceView 里 itemContent
    // 的依赖，内联写法等于每次 ChatView 重渲染都往 react-virtuoso 的 store 发布一份新
    // itemContent（2026-07-30 P0 渲染自激环的放大器之一）。所以这里同时钉「传进去了」
    // 和「是 memo 来的」两件事。
    expect(chatView).toContain('beforeFirstUserMessage={forkSourceHint}');
    expect(chatView).toMatch(/const forkSourceHint = React\.useMemo\([\s\S]*?<ForkSourceHint/);
    expect(traceView).toContain(
      'beforeUserMessage={index === 0 ? beforeFirstUserMessage : undefined}',
    );
  });
});
