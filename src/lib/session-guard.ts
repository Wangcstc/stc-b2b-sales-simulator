import { prisma } from './db';
import { getCurrentUser, canSeeEveryone, type CurrentUser } from './current-user';

/**
 * 这一局是不是你的。
 *
 * ★ 为什么要有 ★
 * 局的地址是 /drill/<id>，以前谁拿到这串 id 都能往里发消息——两个业务员
 * 各自打开自己的局本来互不相干，但只要 URL 传一下（或者浏览器历史里翻到），
 * 就能替别人聊。那局最后算谁的？算被冒名的那个人的。
 *
 * ★ 看与做分开 ★
 * 主管要能看别人的局和报告（盘人用），但不能替人发消息——替人聊出来的分
 * 是假的。所以查看放宽到主管，操作只认本人。
 *
 * ★ 还要看这一局所属的考试收没收 ★（2026-08-28 加）
 * 在这之前这里**只判归属**，于是「跨天作废」这条规则漏了最后一层：
 * 一场作废的考试，它三局的地址 /drill/<id> 照样能打、能评分。
 * 页面上把按钮藏掉治不了这个——按钮藏起来，接口还在（这正是本文件开头那句话）。
 * 所以拦在这里：**已经收掉的考试（SETTLED / EXPIRED），它的局不能再动。**
 * 看还是能看——已经聊过的记录该留着回头查，作废的是继续作答的资格，不是历史。
 */

export type GuardResult =
  | { ok: true; user: CurrentUser; session: { id: string; userId: string } }
  | { ok: false; status: 401 | 403 | 404 | 409; error: string };

async function check(
  sessionId: string,
  mode: 'view' | 'act',
): Promise<GuardResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, status: 401, error: '请先在选人页选择你是谁' };

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { id: true, userId: true, mode: true },
  });
  if (!session) return { ok: false, status: 404, error: '找不到这一局' };

  if (session.userId !== user.id) {
    if (mode === 'view' && canSeeEveryone(user)) return { ok: true, user, session };
    return {
      ok: false,
      status: 403,
      error: mode === 'act' ? '这不是你的局，不能替别人聊' : '这不是你的局',
    };
  }

  /**
   * ★ 只在考试局上查，且只在「做」的时候查 ★
   * 自由练的局（DRILL）根本不挂考试记录，多查一次纯属浪费；
   * 「看」在任何时候都该放行——作废的是继续作答的资格，不是已经聊过的记录。
   */
  if (mode === 'act' && session.mode === 'ADMISSION_EXAM') {
    const closed = await prisma.examAttempt.findFirst({
      where: { sessionIds: { has: sessionId }, verdict: { not: null } },
      select: { verdict: true, businessDay: true },
    });
    if (closed) {
      return {
        ok: false,
        status: 409,
        error:
          closed.verdict === 'EXPIRED'
            ? `${closed.businessDay ?? '那天'} 那场考试已经跨天作废了，这一局不能再打。` +
              '已经打完并出分的局照常进统计窗口；今天的考试请回考试闸门重新开。'
            : `${closed.businessDay ?? '那天'} 那场考试已经交卷了，这一局不能再动。`,
      };
    }
  }

  return { ok: true, user, session };
}

/** 发消息、报价、背调、评分——只认本人 */
export const guardAct = (sessionId: string) => check(sessionId, 'act');

/** 看对话、看报告——本人或主管 */
export const guardView = (sessionId: string) => check(sessionId, 'view');
