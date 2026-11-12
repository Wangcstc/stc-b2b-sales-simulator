import Link from 'next/link';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { prisma } from '@/lib/db';
import { USER_COOKIE } from '@/lib/current-user';
import { hashPassword, verifyPassword, checkPasswordStrength, issueToken } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * 登录页，两步走：先简码，再口令。
 *
 * ★ 不列名单 ★
 * 以前这页把所有人摆出来点一下就进，等于没有门。现在系统在你说出自己是谁之前，
 * 不告诉你这里有谁。
 *
 * ★ 为什么要分两步 ★
 * 第二步长什么样，取决于这个账号设没设过口令：设过就是「口令」，
 * 没设过就是「设置口令 + 再输一遍」。不先问简码就没法决定显示哪个。
 *
 * ★ 不存在的简码也照样进第二步 ★
 * 直接说"没这个人"，就等于把这页变成简码枚举器——
 * 所以一律进第二步，到提交时才统一回「简码或口令不对」。
 *
 * ★ 2026-08-23 修：第二步过去会把「这个账号还没设过口令」直接画在脸上 ★
 * 原来这一页在渲染前先查一次库（passwordHash === null），据此换掉标题、
 * 多画一个「再输一遍」、顶上再加一条黄字「这个账号还没设过口令」。
 * 于是**不用登录**，把简码一个一个填进去就能筛出「哪些账号还没人登过」——
 * 而那种账号谁先登谁就把口令定了，登进去就是那个人的全部对话原文、报告和成绩。
 * 简码只有两位字母，枚举一遍是几百次的事。
 *
 * 现在第二步对**任何**简码长得完全一样：不查库、不换文案、两个框都在。
 * 「再输一遍」不再是必填——第一次登录的人填了就给他校验一致性，
 * 老用户留空就直接验口令。界面上再也读不出这个账号处于什么状态。
 *
 * ★ 这只堵住了「批量筛出来」这一半 ★ 知道某个同事还没登过、直接去替他设口令，
 * 这条路仍然通——那是「谁先登谁定口令」这个流程本身的代价，要堵得改流程
 * （主管发一次性开通码，或加人时由主管设初始口令）。见本次审计报告。
 */

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  path: '/',
  maxAge: 60 * 60 * 24 * 30, // 30 天，一个训练周期
} as const;

/** 第一步：只收简码 */
async function toPasswordStep(formData: FormData) {
  'use server';
  const code = String(formData.get('code') ?? '').trim().toUpperCase();
  if (!code) redirect('/signin?e=' + encodeURIComponent('填一下简码'));
  redirect(`/signin?c=${encodeURIComponent(code)}`);
}

/** 第二步：验口令，或给没设过口令的账号当场设一个 */
async function signIn(formData: FormData) {
  'use server';
  const code = String(formData.get('code') ?? '').trim().toUpperCase();
  const password = String(formData.get('password') ?? '');
  const confirm = formData.get('confirm');

  const back = (msg: string) =>
    redirect(`/signin?c=${encodeURIComponent(code)}&e=${encodeURIComponent(msg)}`);

  if (!code) redirect('/signin');
  if (!password) back('填一下口令');

  const user = await prisma.user.findUnique({ where: { code } });
  if (!user) back('简码或口令不对');

  // ★ 停用的账号在这里拦死 ★ 回话与「简码或口令不对」完全一致——
  // 明说"这个账号被停用了"，等于告诉外人这个简码是真实存在的。
  if (user!.disabledAt) back('简码或口令不对');

  const firstTime = !user!.passwordHash;
  if (firstTime) {
    // ★ 「再输一遍」填了才校验 ★（2026-08-23）这个框现在对所有人都画出来——
    // 它要是必填，老用户每次登录都得输两遍；它要是只对新账号画出来，
    // 这一页就又变回「哪个账号没设过口令」的探测器了。
    const echo = confirm === null ? '' : String(confirm);
    if (echo.length > 0 && echo !== password) back('两次输入的口令不一致');
    const weak = checkPasswordStrength(password);
    if (weak) back(weak);
    await prisma.user.update({
      where: { id: user!.id },
      data: { passwordHash: await hashPassword(password) },
    });
  } else if (!(await verifyPassword(password, user!.passwordHash))) {
    back('简码或口令不对');
  }

  // ★ 登录流水 ★ 主管要知道谁三天没登了——那比任何分数都先说明问题。
  // 写失败不能挡住登录：记流水是附带的事，登不进去才是事故。
  try {
    await prisma.loginEvent.create({
      data: { userId: user!.id, kind: firstTime ? 'FIRST_PASSWORD' : 'SIGN_IN' },
    });
  } catch (error) {
    console.error('[signin] 登录流水写入失败（不影响登录）：', error);
  }

  // ★ 令牌带上版本号 ★（N-9）重置口令/停用/恢复会把它 +1，旧令牌当场作废
  (await cookies()).set(USER_COOKIE, issueToken(user!.code, user!.tokenVersion), COOKIE_OPTS);
  redirect('/');
}

export default async function SignIn({
  searchParams,
}: {
  searchParams: Promise<{ e?: string; c?: string }>;
}) {
  const { e: error, c } = await searchParams;
  const code = (c ?? '').toUpperCase();

  // ★ 这一页一次库都不查 ★（2026-08-23）原来查一次 passwordHash 决定"要不要显示确认栏"，
  // 那一个布尔值就是「这个账号存在且还没人登过」——不登录就能一个简码一个简码地筛。

  return (
    <div className="signin">
      <div className="signin-box">
        <div className="signin-brand">
          <span className="brand-mark" role="img" aria-label="王铖运营社" />
          <div>
            <b style={{ fontSize: 'var(--fs-base)' }}>STC 外贸业务沙盘</b>
            <div className="tiny faint">{code ? `简码 ${code}` : '用你的简码和口令登录'}</div>
          </div>
        </div>

        {error && (
          <div className="card small" style={{ borderColor: 'var(--bad)', color: 'var(--bad)', marginBottom: 14 }}>
            {error}
          </div>
        )}
        {code ? (
          <form action={signIn} className="card" style={{ display: 'grid', gap: 14 }}>
            <input type="hidden" name="code" value={code} />
            {/* ★ 这两个框对任何简码都一模一样 ★ 谁也别想从这一页读出
                「这个账号存不存在、有没有设过口令」——那是登录页最容易漏的一件事。 */}
            <div>
              <label>口令</label>
              <input name="password" type="password" autoFocus required />
            </div>
            <div>
              <label>
                再输一遍 <span className="tiny faint">· 第一次登录才要填</span>
              </label>
              <input name="confirm" type="password" />
            </div>
            <button className="primary" type="submit">
              进入
            </button>
            <a href="/signin" className="tiny faint" style={{ textAlign: 'center' }}>
              换个简码
            </a>
          </form>
        ) : (
          <form action={toPasswordStep} className="card" style={{ display: 'grid', gap: 14 }}>
            <div>
              <label>简码</label>
              {/* 别在这写真人的简码当示例——那等于把名单又漏了一个出去 */}
              <input name="code" placeholder="你的简码" maxLength={6} autoFocus required />
            </div>
            <button className="primary" type="submit">
              下一步
            </button>
          </form>
        )}

        <p className="tiny faint" style={{ marginTop: 18, lineHeight: 1.8 }}>
          <b>第一次登录</b>：口令由你自己定——两个框填同一个，填完就是它了。
          <br />
          <b>以后登录</b>：只填第一个框，第二个留空。
          <br />
          忘了口令找主管重置，重置后下次登录重新设。
        </p>
        <footer className="tiny">
          <Link href="/cooperation" className="cooperation-link">企业合作</Link>
        </footer>
      </div>
    </div>
  );
}
