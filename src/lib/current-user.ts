import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { prisma } from './db';
import { readToken } from './auth';
import { businessDay } from './business-day';

/**
 * 当前是谁。
 *
 * cookie 里存的是**签名令牌**，不是简码明文——改一个字签名就对不上，
 * 拿不到 AUTH_SECRET 就伪造不出来。所以这一层现在是真的授权边界：
 * 别人的局进不去，不是靠前端不显示入口，是靠这里认不出你。
 */

export const USER_COOKIE = 'drill_session';

export interface CurrentUser {
  id: string;
  name: string;
  code: string;
  role: 'TRAINEE' | 'MANAGER' | 'ADMIN';
  employeeType: 'INTERN' | 'REGULAR' | 'MANAGER' | 'OTHER';
  participationMode: 'ADMISSION' | 'WEEKLY_EXAM' | 'NONE';
  /** ★ v1.1 起这是准入的权威状态 ★ 训练期 / 在岗期 */
  stage: 'TRAINING' | 'ACTIVE';
  /** true = 人工锁定，每晚结算只记录不改 stage */
  stageOverride: boolean;
  /** 兼容字段，由 stage 派生。新逻辑一律读 stage */
  inquiryAccessStatus: 'NOT_ADMITTED' | 'PROVISIONAL' | 'ACTIVE' | 'PAUSED' | 'NOT_APPLICABLE';
}

/** 读当前身份。没登录、令牌被改过、令牌过期，一律返回 null */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const claims = readToken((await cookies()).get(USER_COOKIE)?.value);
  if (!claims) return null;

  const user = await prisma.user.findUnique({
    where: { code: claims.code },
    select: {
      tokenVersion: true,
      id: true,
      name: true,
      code: true,
      role: true,
      employeeType: true,
      participationMode: true,
      stage: true,
      stageOverride: true,
      inquiryAccessStatus: true,
      accessSetBy: true,
      overrideUntil: true,
      disabledAt: true,
    },
  });
  // 令牌有效但人被删了：当没登录处理，别让页面炸在下一行
  if (!user) return null;

  /**
   * ★ 令牌版本号比对 ★（漏洞台账 N-9，2026-08-28）
   * 令牌有效期 30 天。在这条之前，主管点「重置口令」之后那个人手上的旧令牌
   * **照样能用一个月**——主管以为把人挡在外面了，其实没有。
   * 重置口令 / 停用 / 恢复三处各把 `tokenVersion` +1，对不上的令牌当场作废。
   *
   * ★ 比对放在这里而不是 auth.ts ★ 那个文件是纯函数、不碰数据库；
   * 而这里本来就要查这个人，比一次不多一次往返。
   */
  if (user.tokenVersion !== claims.tokenVersion) return null;

  // ★ 停用要当场生效，不能等令牌过期 ★ 令牌有 30 天有效期，
  // 只在登录页拦的话，一个已经登录的人被停用后还能照常用一个月。
  if (user.disabledAt) return null;

  // ★ v1.1 起这里不再做「到期应用权限决策」★
  // 期别由 lib/settlement.ts 在每晚结算的当场就写进 User.stage（结算只处理已经过去的
  // 业务日，所以"次日生效"这件事由结算日本身保证，不需要读路径再补一次）。
  //
  // 旧写法把生效动作挂在**被判定人自己登录**这件事上：他不登录，主管在账号管理页
  // 看到的就还是昨天那个状态，照着一个滞后的状态分询盘。这是 v3.0 的一个洞，
  // 顺手在这里堵上——同时也意味着 V3_SHADOW_MODE 不再能挡住 v1.1 的判定生效。

  const {
    disabledAt: _ignored,
    accessSetBy: _setBy,
    overrideUntil: _overrideUntil,
    tokenVersion: _tokenVersion,
    ...rest
  } = user;
  return rest;
}

/** 页面用：没登录直接送去选人页 */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect('/signin');
  return user;
}

/** 主管和管理员能看全员数据，新人只能看自己 */
export function canSeeEveryone(user: CurrentUser): boolean {
  return user.role === 'MANAGER' || user.role === 'ADMIN';
}
