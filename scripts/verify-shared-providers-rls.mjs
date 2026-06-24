#!/usr/bin/env node
// ============================================================================
// anon-probe：用「公开的」anon key 去查敏感控制面表，证明 RLS 没写松。
// anon key 本就是公开的（打进客户端/每个请求头都带），所以 RLS 是唯一的墙——这个脚本验证那道墙真的在。
//
// 通过判定：anon 要么被拒（401/403），要么查到 0 行（RLS 过滤）。读到 ≥1 行 = RLS 写松了 → 退出码 1。
//
// 用法：
//   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_ANON_KEY=<anon> node scripts/verify-shared-providers-rls.mjs
//   # 国际网络需代理：HTTPS_PROXY=http://127.0.0.1:7897 node scripts/verify-shared-providers-rls.mjs
//   或 node scripts/verify-shared-providers-rls.mjs <url> <anon_key>
// ============================================================================

const url = (process.env.SUPABASE_URL ?? process.argv[2] ?? '').replace(/\/+$/, '');
const anon = process.env.SUPABASE_ANON_KEY ?? process.argv[3] ?? '';

if (!url || !anon) {
  console.error('需要 SUPABASE_URL + SUPABASE_ANON_KEY（env 或前两个参数）。');
  process.exit(2);
}

// 这些表都不应让 anon / 非管理员读到任何一行
const SENSITIVE_TABLES = [
  'control_plane_shared_providers',
  'control_plane_shared_service_keys',
  'control_plane_shared_service_key_pool_state',
  'control_plane_entitlements',
];

let failed = false;

for (const table of SENSITIVE_TABLES) {
  try {
    const res = await fetch(`${url}/rest/v1/${table}?select=*&limit=5`, {
      headers: { apikey: anon, Authorization: `Bearer ${anon}` },
    });

    if (!res.ok) {
      console.log(`✓ ${table}: anon 被拒（HTTP ${res.status}）`);
      continue;
    }

    const rows = await res.json().catch(() => null);
    if (Array.isArray(rows) && rows.length === 0) {
      console.log(`✓ ${table}: anon 可查询但 RLS 过滤为 0 行`);
      continue;
    }

    console.error(`✗ ${table}: anon 读到了 ${Array.isArray(rows) ? rows.length : '未知'} 行 —— RLS 写松了！`);
    failed = true;
  } catch (error) {
    console.error(`! ${table}: 请求失败（${error?.message ?? error}）——无法验证，请检查网络/代理后重跑。`);
    failed = true;
  }
}

if (failed) {
  console.error('\nRLS 验证未通过：上面标 ✗ 的表对 anon 暴露了数据，必须修 RLS 后重跑。');
  process.exit(1);
}
console.log('\n✓ RLS 验证通过：敏感表对 anon 全部不可读。');
process.exit(0);
