import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = path.resolve(
  process.cwd(),
  'supabase/migrations/20260730000000_collab_spaces.sql',
);
const sql = readFileSync(migrationPath, 'utf8');

describe('collaboration spaces cloud migration contract', () => {
  it.each(['collab_projects', 'project_members', 'project_invites'])(
    'creates and enables RLS on %s',
    (table) => {
      expect(sql).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}`));
      expect(sql).toMatch(new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`));
    },
  );

  it('never exposes project_invites through a SELECT policy', () => {
    expect(sql).not.toMatch(
      /CREATE POLICY[\s\S]*?ON public\.project_invites\s+FOR SELECT/iu,
    );
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.redeem_project_invite(TEXT) FROM PUBLIC, anon');
  });

  it('locks, validates, inserts, and increments invite redemption atomically', () => {
    const redeemBody = sql.slice(
      sql.indexOf('CREATE OR REPLACE FUNCTION public.redeem_project_invite'),
      sql.indexOf('CREATE OR REPLACE FUNCTION public.revoke_project_invite'),
    );

    expect(redeemBody).toContain('SECURITY DEFINER');
    expect(redeemBody).toContain('FOR UPDATE');
    expect(redeemBody).toContain('COLLAB_INVITE_REVOKED');
    expect(redeemBody).toContain('COLLAB_INVITE_EXPIRED');
    expect(redeemBody).toContain('COLLAB_INVITE_EXHAUSTED');
    expect(redeemBody).toContain('INSERT INTO public.project_members');
    expect(redeemBody).toContain('SET used_count = invite.used_count + 1');
  });

  it('documents the allow/deny intent immediately before every RLS policy', () => {
    const lines = sql.split('\n');
    const policyLineIndexes = lines
      .map((line, index) => line.startsWith('CREATE POLICY') ? index : -1)
      .filter((index) => index >= 0);

    expect(policyLineIndexes.length).toBeGreaterThan(0);
    for (const index of policyLineIndexes) {
      expect(lines[index - 1]?.trim()).toMatch(/^-- .*放行.*；拦截/u);
    }
  });
});
