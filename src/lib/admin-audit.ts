/**
 * 管理动作流水（2026-08-22）
 *
 * ★ 在这之前只有「改期别」留了痕 ★ `AccessDecision` 记着谁把谁的期别改成了什么、
 * 为什么、哪天生效，账号管理页底下那张「主管改过的期别」在展示它。
 * 而另外十一个动作——加人、改角色、改身份、重置口令、停用、恢复、删除、
 * 标假期、标调休、标请假、点重算——**一条记录都没有**。
 *
 * 具体是什么后果：一个人的口令被谁重置过、某天为什么标成假期、
 * 上个月那次重算是谁点的、谁把某人从实习改成了正式——事后一律查不到。
 * 而这些动作里有一半会直接影响判定结果。
 *
 * ★ 日历那两张表其实一直在写 setBy/setAt，只是没人看 ★
 * 那两列从 2026-08-21 建表起就有，`BusinessCalendar.label` 更是写都没写过。
 * 但它们只记得住「最后一次是谁改的」——改过又改回来就看不出了。
 * 流水记的是每一次，两者不重复。
 *
 * ★ 只增不改不删 ★ 这是流水，不是状态。写进去就不动了。
 * 出错不许打断主流程：审计写失败，不能让「停用一个人」这件事也跟着失败。
 */

import { prisma } from './db';

export type AuditAction =
  | 'USER_ADD'
  | 'USER_DELETE'
  | 'USER_DISABLE'
  | 'USER_ENABLE'
  | 'ROLE_CHANGE'
  | 'IDENTITY_CHANGE'
  | 'PASSWORD_RESET'
  | 'CALENDAR_SET'
  | 'LEAVE_SET'
  | 'RESETTLE'
  | 'DIFFICULTY_SET'
  | 'WORKSHOP_INGEST'
  | 'WORKSHOP_RUN'
  | 'WORKSHOP_RETRY'
  | 'WORKSHOP_ANSWER'
  | 'BANK_PACK'
  | 'BANK_LOAD'
  | 'BANK_ACTIVATE'
  | 'BANK_QUESTION_TOGGLE'
  | 'BANK_EXPORT'
  | 'FEEDBACK_DECIDE';

/** 动作代号 → 中文。★ 中文不进库 ★ 改个说法不该要一次数据迁移 */
export const AUDIT_LABEL: Record<AuditAction, string> = {
  USER_ADD: '加了一个人',
  USER_DELETE: '删除账号',
  USER_DISABLE: '停用',
  USER_ENABLE: '恢复',
  ROLE_CHANGE: '改角色',
  IDENTITY_CHANGE: '改身份',
  PASSWORD_RESET: '重置口令',
  CALENDAR_SET: '标工作日历',
  LEAVE_SET: '标请假',
  RESETTLE: '重算历史判定',
  DIFFICULTY_SET: '调难度系数',
  WORKSHOP_INGEST: '题库工坊投料',
  WORKSHOP_RUN: '题库工坊开工',
  WORKSHOP_RETRY: '题库工坊重做',
  WORKSHOP_ANSWER: '题库工坊确认',
  BANK_PACK: '打包题库',
  BANK_LOAD: '装入题库',
  BANK_ACTIVATE: '切换题库版本',
  BANK_QUESTION_TOGGLE: '停用或恢复题目',
  BANK_EXPORT: '导出题库包',
  FEEDBACK_DECIDE: '回炉建议拍板',
};

/** 这几个动作会直接影响判定结果，界面上要标出来 */
export const AFFECTS_JUDGEMENT: ReadonlySet<AuditAction> = new Set<AuditAction>([
  'IDENTITY_CHANGE',
  'USER_DISABLE',
  'USER_ENABLE',
  'CALENDAR_SET',
  'LEAVE_SET',
  'RESETTLE',
  // 难度系数同时改标尺和门槛，是这里面影响面最大的一个——全员、所有新局
  'DIFFICULTY_SET',
]);

export interface AuditInput {
  actorId: string;
  action: AuditAction;
  /** 被操作的人。标假期、点重算这类针对全员的动作不填 */
  subjectId?: string | null;
  /** 改之前长什么样。加人这种没有「之前」的不填 */
  before?: string | null;
  /** 改之后长什么样 */
  after?: string | null;
  /** 理由、事由、备注 */
  note?: string | null;
}

/**
 * 记一笔。
 *
 * ★ 永远不抛 ★ 审计是旁路。写流水失败不该让「停用一个人」这件事也跟着失败——
 * 那会把一个记账问题变成一个业务事故。失败就在服务端日志里留一行，人还是能干活。
 */
export async function audit(input: AuditInput): Promise<void> {
  try {
    await prisma.adminAudit.create({
      data: {
        actorId: input.actorId,
        subjectId: input.subjectId ?? null,
        action: input.action,
        before: input.before ?? null,
        after: input.after ?? null,
        note: input.note ?? null,
      },
    });
  } catch (error) {
    console.error('[admin-audit] 写流水失败，主流程继续：', input.action, error);
  }
}

export interface AuditRow {
  id: string;
  at: Date;
  action: AuditAction;
  actorName: string;
  subjectName: string | null;
  subjectCode: string | null;
  before: string | null;
  after: string | null;
  note: string | null;
}

/**
 * 最近的管理动作。账号管理页底下一张表。
 *
 * @param subjectId 只看「对这个人做的」动作。★ 业务员看自己那份用它 ★（2026-08-22 王老师定）
 *   业务员该知道主管动过他什么（改身份、改期别、停用、标请假），
 *   但主管对**别人**做了什么与他无关——所以过滤是「对象是我」，不是「全部」。
 *   subjectId 为 null 的全员动作（标日历、批量重算）也不进他这一份：
 *   那不是对他账号的修改，日历改了什么他在上面那张只读日历里看得见。
 */
export async function loadAuditLog(take = 60, subjectId?: string): Promise<AuditRow[]> {
  const rows = await prisma.adminAudit.findMany({
    where: subjectId ? { subjectId } : undefined,
    orderBy: { at: 'desc' },
    take,
    include: {
      actor: { select: { name: true } },
      subject: { select: { name: true, code: true } },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    at: row.at,
    action: row.action as AuditAction,
    actorName: row.actor.name,
    subjectName: row.subject?.name ?? null,
    subjectCode: row.subject?.code ?? null,
    before: row.before,
    after: row.after,
    note: row.note,
  }));
}
