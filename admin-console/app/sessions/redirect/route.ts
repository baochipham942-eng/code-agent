import { NextResponse } from 'next/server';

// 表单 GET 跳转：/sessions/redirect?id=xxx → /sessions/[id]
export function GET(req: Request) {
  const url = new URL(req.url);
  const id = (url.searchParams.get('id') ?? '').trim();
  if (!id) {
    return NextResponse.redirect(new URL('/', req.url));
  }
  return NextResponse.redirect(new URL(`/sessions/${encodeURIComponent(id)}`, req.url));
}
