#!/usr/bin/env node
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';

const MIGRATION_ID = '20260517000000_control_plane_governance';
const MIGRATION_FILE = resolve('supabase/migrations/20260517000000_control_plane_governance.sql');

function usage() {
  return [
    'Usage:',
    '  node scripts/apply-control-plane-governance-migration.mjs',
    '  node scripts/apply-control-plane-governance-migration.mjs --apply --confirm 20260517000000_control_plane_governance',
    '',
    'Default mode is dry-run. Apply mode executes only the control-plane governance migration file.',
    'Requires DATABASE_URL or CONTROL_PLANE_AUDIT_DATABASE_URL in the environment.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {
    apply: false,
    confirm: null,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (arg === '--apply') {
      args.apply = true;
      continue;
    }
    if (arg === '--confirm') {
      args.confirm = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function readDatabaseUrl() {
  return process.env.CONTROL_PLANE_AUDIT_DATABASE_URL
    || process.env.CODE_AGENT_CONTROL_PLANE_AUDIT_DATABASE_URL
    || process.env.DATABASE_URL
    || null;
}

function migrationMetadata(sql) {
  return {
    file: MIGRATION_FILE,
    id: MIGRATION_ID,
    sha256: `sha256:${crypto.createHash('sha256').update(sql).digest('hex')}`,
    creates: [
      'public.control_plane_entitlements',
      'public.control_plane_audit_events',
      'public.admin_list_control_plane_audit_events',
      'public.admin_control_plane_rollout_summary',
    ],
  };
}

async function verify(sql) {
  const rows = await sql`
    select
      to_regclass('public.control_plane_entitlements')::text as entitlements_table,
      to_regclass('public.control_plane_audit_events')::text as audit_events_table,
      to_regprocedure('public.admin_list_control_plane_audit_events(integer)')::text as audit_events_rpc,
      to_regprocedure('public.admin_control_plane_rollout_summary()')::text as rollout_summary_rpc
  `;
  return rows[0] ?? {};
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[control-plane-governance-migration] ${error.message}`);
    console.error(usage());
    process.exit(2);
  }

  if (args.help) {
    console.log(usage());
    return;
  }

  const migrationSql = readFileSync(MIGRATION_FILE, 'utf8');
  const metadata = migrationMetadata(migrationSql);
  if (!args.apply) {
    console.log('[control-plane-governance-migration] dry-run only');
    console.log(JSON.stringify(metadata, null, 2));
    console.log(`[control-plane-governance-migration] pass --apply --confirm ${MIGRATION_ID} to execute`);
    return;
  }

  if (args.confirm !== MIGRATION_ID) {
    throw new Error(`Apply mode requires --confirm ${MIGRATION_ID}`);
  }

  const databaseUrl = readDatabaseUrl();
  if (!databaseUrl) {
    throw new Error('DATABASE_URL or CONTROL_PLANE_AUDIT_DATABASE_URL is required');
  }

  const sql = postgres(databaseUrl, {
    max: 1,
    idle_timeout: 1,
    connect_timeout: 5,
    prepare: false,
  });
  try {
    await sql.begin(async (trx) => {
      await trx.unsafe(migrationSql);
    });
    const verification = await verify(sql);
    console.log('[control-plane-governance-migration] applied');
    console.log(JSON.stringify({ ...metadata, verification }, null, 2));
  } finally {
    await sql.end({ timeout: 1 });
  }
}

main().catch((error) => {
  console.error(`[control-plane-governance-migration] ${error.message}`);
  process.exit(1);
});
