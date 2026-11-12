import Link from 'next/link';
import { businessDay } from '@/lib/business-day';
import { isWeeklyTrack } from '@/lib/exam-track';
import { catchUpWeeks, previewWeek } from '@/lib/weekly-settlement';
import { WEEKLY_EXAM_CONFIG, weekRangeText } from '@/lib/weekly-exam';
import type { CurrentUser } from '@/lib/current-user';
import Help from './Help';
import Icon from './Icon';

/**
 * 正式业务员的本周考试进度卡。**对应实习业务员那边的 AdmissionPanel。**
 *
 * ★ 它和准入面板最要紧的区别：没有横幅、没有期别、没有「差 N 分」的威胁 ★
 * 准入面板要回答的是「我明天还有没有询盘」，所以它必须把距离摆到脸上；
 * 这一张只回答「我这周的考试任务做完没有」。中位数摆出来是让他知道自己在哪一档，
 * 不是门槛——2026-08-24 王老师定：周考只记录，不挂任何处罚。
 *
 * ★ 只有首页用它 ★（2026-08-27）
 * 原来考试闸门那一页也摆一张（compact 模式），但那一页有状态屏，
 * 这张卡说的每一件事状态屏里都有——已经删掉，compact 这个开关也跟着撤了。
 */
export default async function WeeklyExamPanel({ user }: { user: CurrentUser }) {
  if (!isWeeklyTrack(user)) return null;

  const today = businessDay();
  // 读页面顺手补账。幂等——和 AdmissionPanel 调 catchUpSettlement 是同一个道理：
  // 定时任务漏跑一次，业务员一开页面就把这周的账补上，不必等主管发现。
  await catchUpWeeks(user.id, today);
  const week = await previewWeek(user.id, today);

  const { examsPerWeek, sessionsPerWeek } = WEEKLY_EXAM_CONFIG;
  const done = week.met === true;

  return (
    <div
      className="card section-block"
      style={{ borderColor: done ? 'var(--ok)' : 'var(--accent)' }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: 14,
          flexWrap: 'wrap',
          alignItems: 'center',
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <b>正式业务员 · 本周考试</b>
            <Help topic="train-weekly-req" />
          </div>
          <div className="small muted" style={{ marginTop: 5 }}>
            {weekRangeText(week.weekStart)} · 每周至少 {examsPerWeek} 场（{sessionsPerWeek} 局）
          </div>
        </div>
        <Link href="/exam">
          <button className={done ? '' : 'primary'}>{done ? '再练一场' : '去考试闸门'}</button>
        </Link>
      </div>

      <div
        className="card"
        style={{
          marginTop: 14,
          background: 'var(--panel-2)',
          // 达标时那圈绿是语义色（说明「考满了」），要留；没达标时不描边——
          // 外面那张卡已经框了一圈，见 globals.css 的 `.card .card`
          borderColor: done ? 'var(--ok)' : 'transparent',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <b className="small with-ico">
            <Icon name={done ? 'check' : 'target'} size={14} />
            本周 {week.examCount} / {examsPerWeek} 场 · 已出分 {week.preciseCount} / {sessionsPerWeek} 局
          </b>
        </div>
        <div className="small muted" style={{ marginTop: 6, lineHeight: 1.8 }}>
          {week.detail}
        </div>
      </div>

      {/* ── 状态条 ──
          ★ 中位数必须带样本 ★ 只写「68 分」，看的人不知道那是 6 局算的还是 1 局算的。
          样本不齐时它连一档都说明不了，那就更要把分母摆出来。 */}
      <div className="small" style={{ marginTop: 14 }}>
        <span className="section-label" style={{ margin: 0, marginRight: 8 }}>
          本周中位数
        </span>
        {week.medianScore === null ? (
          <span className="faint">还没有出分的考试局</span>
        ) : (
          <>
            <b className="num">{week.medianScore}</b>
            <span className="muted">
              {' '}
              分 · 本周 {week.preciseCount}/{sessionsPerWeek} 局
              {week.scoreOk === false ? ` · 参考线 ${WEEKLY_EXAM_CONFIG.medianScoreMin} 分` : ''}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
