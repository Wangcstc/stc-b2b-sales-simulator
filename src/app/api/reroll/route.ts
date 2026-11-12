import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/current-user';
import { rerollCookieName } from '@/lib/inquiry-pool';

/**
 * 首页「换一批」。每日一次，换完回首页。
 *
 * ★ 为什么不在首页里直接写 cookie ★ server component 里不能写，
 * 只有 route handler 和 server action 能。这里用 NextResponse 把 Set-Cookie
 * 挂在重定向响应上，是这条路上最不容易出岔子的写法。
 *
 * 已经换过就什么都不做直接跳回去——按钮那时本来就是灰的，
 * 会走到这一步的多半是有人手打了地址，不必给他报错。
 */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  const res = NextResponse.redirect(new URL(user ? '/' : '/signin', req.url));
  if (!user) return res;

  const key = rerollCookieName();
  const used = (await cookies()).get(key)?.value === '1';
  if (!used) {
    res.cookies.set(key, '1', {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 60 * 60 * 48, // 两天，跨过业务日就自然失效，不必清理
    });
  }
  return res;
}
