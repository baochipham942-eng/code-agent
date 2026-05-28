// 服务端 Supabase 客户端（Server Component / Server Action / Route Handler 用）
// 走 cookie 维持 session，admin RLS 由 is_code_agent_admin() 在 DB 层把关。
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Server Component 上下文不允许设 cookie；middleware 已负责刷新，忽略即可
          }
        },
      },
    },
  );
}
