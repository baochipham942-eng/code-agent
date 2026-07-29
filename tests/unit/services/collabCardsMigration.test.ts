import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = path.resolve(
  process.cwd(),
  'supabase/migrations/20260730001000_collab_cards.sql',
);
const sql = readFileSync(migrationPath, 'utf8');

describe('collaboration cards cloud migration contract', () => {
  it('creates the card identity envelope and metadata-only columns', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.collab_cards');
    expect(sql).toContain('id UUID PRIMARY KEY DEFAULT gen_random_uuid()');
    expect(sql).toContain(
      'project_id UUID NOT NULL REFERENCES public.collab_projects(id) ON DELETE CASCADE',
    );
    expect(sql).toContain(
      'source_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE',
    );
    expect(sql).toContain(
      'UNIQUE (project_id, source_user_id, local_card_id)',
    );
    expect(sql).toContain(
      'requester_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT',
    );
    expect(sql).not.toMatch(/\b(content|body|read_scope|write_scope|file_path|workspace_path)\b/iu);
  });

  it('lets members select while source uid exclusively owns mutations', () => {
    expect(sql).toContain('ALTER TABLE public.collab_cards ENABLE ROW LEVEL SECURITY');
    expect(sql).toMatch(
      /FOR SELECT TO authenticated\s+USING \(public\.is_collab_project_member\(project_id\)\)/u,
    );
    expect(sql).toMatch(
      /FOR INSERT TO authenticated[\s\S]*?source_user_id = auth\.uid\(\)[\s\S]*?is_collab_project_member\(project_id\)/u,
    );
    expect(sql).toMatch(
      /FOR UPDATE TO authenticated[\s\S]*?USING \([\s\S]*?source_user_id = auth\.uid\(\)[\s\S]*?WITH CHECK \([\s\S]*?source_user_id = auth\.uid\(\)/u,
    );
    expect(sql).toMatch(
      /FOR DELETE TO authenticated[\s\S]*?source_user_id = auth\.uid\(\)/u,
    );
  });

  it('is rerunnable because every created schema object has an idempotency guard', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.collab_cards');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_collab_cards_project_updated');

    const createdPolicies = [...sql.matchAll(/CREATE POLICY "([^"]+)"/gu)]
      .map((match) => match[1]);
    expect(createdPolicies).toHaveLength(4);
    for (const policy of createdPolicies) {
      expect(sql).toContain(`DROP POLICY IF EXISTS "${policy}" ON public.collab_cards`);
    }
  });
});
