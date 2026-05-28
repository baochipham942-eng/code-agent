import { signOut } from '@/app/login/actions';

export default function UnauthorizedPage() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-zinc-950 text-zinc-100 p-6">
      <div className="text-center space-y-3">
        <h1 className="text-2xl font-semibold">无权访问</h1>
        <p className="text-sm text-zinc-400 max-w-sm">
          本控制台仅管理员可见（profiles.is_admin = true）。如需访问，请联系管理员把当前账号标为 admin。
        </p>
        <form action={signOut}>
          <button className="text-sm text-zinc-500 hover:text-zinc-300 underline">换个账号</button>
        </form>
      </div>
    </main>
  );
}
