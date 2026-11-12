'use server';

import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { requireUser } from '@/lib/current-user';
import { hashPassword, verifyPassword, checkPasswordStrength } from '@/lib/auth';

/**
 * 改自己的口令。**从 /account 搬过来的**（2026-08-26）。
 *
 * ★ 为什么搬 ★ 原来它独占一页，右上角还占着一个「账号」入口。可那一页只有三件事：
 * 看账号信息、改口令、退出登录——而「账号信息」在 /team 的「我的账号」卡片里
 * 显示得更全（多了身份、训练要求、练了多少、最近登录）。一个入口、一整页，
 * 只为了两个动作，而其中一个还和别处重复。
 *
 * ★ 顺带修掉一处「文案把功能藏起来」★ 业务员那张卡片的「口令」格子写的是
 * 「已设置 · 忘了找主管重置」——可他本来就能自己改，这句话在教人去麻烦主管。
 *
 * ★ 抽成单独的 'use server' 模块，不留在页面文件里 ★
 * 两个视角都要用它：主管在账号管理页、业务员在同一页的只读视图。
 * 放在任一个组件文件里都会变成另一个文件去 import 一个页面——那种依赖方向很难维护。
 *
 * ★ 必须先验旧口令 ★ 不然别人趁你没锁屏就能把你的号改走。
 * 这条是从 /account 原样继承的，不能因为搬了地方就松掉。
 */
export async function changeMyPassword(formData: FormData) {
  const me = await requireUser();

  const current = String(formData.get('current') ?? '');
  const next = String(formData.get('next') ?? '');
  const confirm = String(formData.get('confirm') ?? '');

  // ★ 结果走查询串回到 /team，不带锚点 ★
  // 改口令现在是弹窗：校验失败是一次真实导航，弹窗会随页面重建而关掉，
  // 所以由 ChangePassword 在挂载时读到 pwErr / pwOk 再把弹窗打开。
  // 锚点在这里没有意义——要滚到的那一块已经不存在了。
  const fail = (msg: string) => redirect(`/team?pwErr=${encodeURIComponent(msg)}`);

  const row = await prisma.user.findUniqueOrThrow({
    where: { id: me.id },
    select: { passwordHash: true },
  });
  if (!(await verifyPassword(current, row.passwordHash))) fail('当前口令不对');
  if (next !== confirm) fail('两次输入的新口令不一致');

  const weak = checkPasswordStrength(next);
  if (weak) fail(weak);

  await prisma.user.update({
    where: { id: me.id },
    data: { passwordHash: await hashPassword(next) },
  });
  redirect('/team?pwOk=1');
}
