// ============================================================================
// SessionCreateBodySchema：创建会话 body 类型闸门。
// ============================================================================
import { describe, expect, it } from 'vitest';
import { SessionCreateBodySchema } from '../../../src/web/routes/sessionBodySchemas';

describe('SessionCreateBodySchema', () => {
  it('accepts empty body (defaults applied by route)', () => {
    expect(SessionCreateBodySchema.safeParse({}).success).toBe(true);
  });

  it('accepts optional title and workingDirectory strings', () => {
    const result = SessionCreateBodySchema.safeParse({
      title: 'Workbench',
      workingDirectory: '/tmp/x',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.title).toBe('Workbench');
      expect(result.data.workingDirectory).toBe('/tmp/x');
    }
  });

  it('rejects non-string title / workingDirectory', () => {
    expect(SessionCreateBodySchema.safeParse({ title: 1 }).success).toBe(false);
    expect(SessionCreateBodySchema.safeParse({ workingDirectory: { path: '/x' } }).success).toBe(false);
  });

  it('passthrough keeps unknown fields for forward compatibility', () => {
    const result = SessionCreateBodySchema.safeParse({
      title: 't',
      clientHint: 'mobile',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { clientHint?: string }).clientHint).toBe('mobile');
    }
  });
});
