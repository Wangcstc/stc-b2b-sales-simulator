/**
 * 「他走哪条考试轨」——考试链路上唯一的身份判据。
 *
 * ★ 2026-08-24 王老师定：正式业务员也要能练、能考 ★
 * 在这之前，考试链路从头到尾写死 `INTERN && ADMISSION`，正式业务员被整条排除：
 * 考试按钮永远不亮、`/train` 404、`/team` 404，可版头偏偏还渲染着
 * 「今日考试 未开始 · 每人每日 1 场」——拦住了还骗人一下，那不叫锁。
 *
 * 两条轨的区别**只有训练要求**，功能一模一样：
 *   · ADMISSION（实习业务员）—— 训练期当日先练 3 局才解锁考试；
 *     判定看最近 2 个业务日 6 局的中位数，管**询盘分配权**。
 *   · WEEKLY（正式业务员）—— 随时可考，不要求先练；
 *     要求每周至少 2 场（6 局），成绩照样落账，但**不挂任何权限后果**。
 *
 * ★ 为什么不直接复用 employeeType ★ 身份是「他是哪种员工」，轨是「他按哪套规则考」。
 * 两者今天一一对应，明天未必——真把 employeeType 拿去当考试开关，
 * 下次加一种员工身份就得把这 60 多处判断重读一遍。
 */

export type ExamTrack = 'ADMISSION' | 'WEEKLY' | null;

export interface TrackedIdentity {
  employeeType: string;
  participationMode: string;
}

/** 他走哪条考试轨。null = 不参加考试（主管、身份待确认） */
export function examTrackOf(user: TrackedIdentity): ExamTrack {
  if (user.employeeType === 'INTERN' && user.participationMode === 'ADMISSION') return 'ADMISSION';
  if (user.employeeType === 'REGULAR' && user.participationMode === 'WEEKLY_EXAM') return 'WEEKLY';
  return null;
}

/** 走准入那一套（每日判定、期别、询盘分配权）。只有实习业务员成立 */
export function isAdmissionTrack(user: TrackedIdentity): boolean {
  return examTrackOf(user) === 'ADMISSION';
}

/** 走周考那一套（每周 2 场，只记录不处罚）。只有正式业务员成立 */
export function isWeeklyTrack(user: TrackedIdentity): boolean {
  return examTrackOf(user) === 'WEEKLY';
}

/** 界面上说人话用的轨名。★ 页面上不许出现 ADMISSION / WEEKLY 这种枚举原文 ★ */
export const TRACK_LABEL: Record<'ADMISSION' | 'WEEKLY', string> = {
  ADMISSION: '准入训练',
  WEEKLY: '周考',
};
