import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('ChatView Surface Execution integration', () => {
  it('renders the conversation panel outside the turn trace and binds scoped controls', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'src/renderer/components/ChatView.tsx'),
      'utf8',
    );
    const panel = source.indexOf('<SurfaceExecutionChatPanel');
    const trace = source.indexOf('<TurnBasedTraceView');

    expect(source).toContain('<SurfaceExecutionChatPanel conversationId={currentSessionId} />');
    expect(panel).toBeGreaterThan(0);
    expect(trace).toBeGreaterThan(panel);
  });

  it('keeps the native Surface subscription at App scope when ChatView is replaced', () => {
    const appSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/renderer/App.tsx'),
      'utf8',
    );
    const agentEffectsSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/renderer/hooks/agent/useAgentEffects.ts'),
      'utf8',
    );

    expect(appSource).toContain('useSurfaceExecutionEffects(currentSessionId);');
    expect(agentEffectsSource).not.toContain('useSurfaceExecutionEffects(');
  });
});
