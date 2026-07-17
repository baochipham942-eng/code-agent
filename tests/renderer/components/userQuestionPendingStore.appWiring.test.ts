import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('App user question pending-store wiring', () => {
  it('records session-scoped user questions and clears the current request on modal close', () => {
    const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/App.tsx'), 'utf8');

    expect(appSource).toContain('useSessionStore.getState().addPendingUserQuestion(request)');
    expect(appSource).toContain('useSessionStore.getState().clearPendingUserQuestion(current)');
    expect(appSource).toContain('onClose={closeUserQuestion}');
  });
});
