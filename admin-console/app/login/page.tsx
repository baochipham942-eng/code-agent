import { signIn } from './actions';

type SP = Promise<{ error?: string; next?: string }>;

export default async function LoginPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  return (
    <main className="min-h-screen flex items-center justify-center bg-zinc-950 text-zinc-100 p-6">
      <form
        action={signIn}
        className="w-full max-w-sm space-y-4 p-8 rounded-xl border border-zinc-800 bg-zinc-900/40"
      >
        <div>
          <h1 className="text-xl font-semibold">Agent Neo · Admin</h1>
          <p className="text-sm text-zinc-500 mt-1">仅管理员可登录。</p>
        </div>
        <input type="hidden" name="next" value={sp?.next ?? '/'} />
        <input
          name="email"
          type="email"
          required
          placeholder="邮箱"
          className="w-full px-3 py-2 rounded bg-zinc-900 border border-zinc-800 focus:border-zinc-600 outline-none text-sm"
        />
        <input
          name="password"
          type="password"
          required
          placeholder="密码"
          className="w-full px-3 py-2 rounded bg-zinc-900 border border-zinc-800 focus:border-zinc-600 outline-none text-sm"
        />
        {sp?.error ? (
          <p className="text-red-400 text-xs">{sp.error}</p>
        ) : null}
        <button
          type="submit"
          className="w-full py-2 rounded bg-blue-600 hover:bg-blue-700 font-medium text-sm"
        >
          登录
        </button>
      </form>
    </main>
  );
}
