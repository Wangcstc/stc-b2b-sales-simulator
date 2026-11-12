import { NextResponse } from 'next/server';
import { USER_COOKIE } from '@/lib/current-user';

/** 切换身份：清掉 cookie 送回选人页。没有密码，所以"退出"就只是忘掉是谁 */
export async function GET(req: Request) {
  const res = NextResponse.redirect(new URL('/signin', req.url));
  res.cookies.delete(USER_COOKIE);
  return res;
}
