/**
 * 题库工坊接口的门：只有主管和管理员进得来（需求文档 5.1）；投料、加工、确认三类接口还要求常驻服务器。
 * ★ 每个接口自己查一遍 ★ 页面上藏起来不算权限，接口能被直接调。
 */
import { NextResponse } from 'next/server';
import { canSeeEveryone, getCurrentUser, type CurrentUser } from '../current-user';
import { BANK_ONLY_NOTICE, workshopMode } from './mode';

export async function requireWorkshop(opts: { full?: boolean } = {}): Promise<{ user: CurrentUser; denied?: undefined } | { denied: NextResponse; user?: undefined }> {
  const user = await getCurrentUser();
  if (!user) return { denied: NextResponse.json({ error: '请先登录' }, { status: 401 }) };
  if (!canSeeEveryone(user)) return { denied: NextResponse.json({ error: '题库工坊只给主管和管理员用' }, { status: 403 }) };
  if (opts.full && workshopMode() !== 'full') return { denied: NextResponse.json({ error: BANK_ONLY_NOTICE }, { status: 409 }) };
  return { user };
}

/** 接口里抛出来的错，原样把中文原因交给页面 */
export function fail(e: unknown, status = 400): NextResponse {
  return NextResponse.json({ error: (e as Error).message ?? String(e) }, { status });
}
