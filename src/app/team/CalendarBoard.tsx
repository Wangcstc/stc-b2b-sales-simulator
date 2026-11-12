'use client';

import { useMemo, useState, useTransition } from 'react';
import { resettleFrom, setCalendarDay, setLeaveDay } from './calendar-actions';

/**
 * 工作日历 / 个人请假：点日历标记（2026-08-21，王老师定）
 *
 * ★ 只有一个动作 ★ 原来做成了「标放假」和「标调休」两个表单，是想复杂了——
 * 两者其实是同一件事：**这天和默认不一样**。默认周一至周五上班、周末休息，
 * 点一个周四就是放假，点一个周六就是调休上班。所以界面上只有一张日历，
 * 点哪天算哪天；「调休」不再是一个功能，只是「你点了周末」的自然结果。
 *
 * ★ 一次只给一个月 ★ 排班本来就是一个月一个月看的，铺一年只会让人找不到今天。
 *
 * ★ 日期计算全部用 UTC 正午承载 ★ 纯日期不带时区，用本地时间构造 Date
 * 会在某些时区里跨日，月初月末各差一天。
 */

interface Mark {
  day: string;
  isWorkday: boolean;
}
interface Leave {
  code: string;
  day: string;
  reason: string | null;
}

const pad = (n: number) => String(n).padStart(2, '0');
const WEEK = ['一', '二', '三', '四', '五', '六', '日'];
const REASONS = ['病假', '事假', '出差', '年假', '其他'];

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y!, m! - 1 + delta, 1, 12));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}
function daysOfMonth(month: string): string[] {
  const [y, m] = month.split('-').map(Number);
  const out: string[] = [];
  const cursor = new Date(Date.UTC(y!, m! - 1, 1, 12));
  while (cursor.getUTCMonth() === m! - 1) {
    out.push(`${y}-${pad(m!)}-${pad(cursor.getUTCDate())}`);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}
/** 0=周一 … 6=周日。JS 的 getUTCDay 是 0=周日，中国人的日历从周一起 */
function weekIndex(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return (new Date(Date.UTC(y!, m! - 1, d!, 12)).getUTCDay() + 6) % 7;
}
const isWeekend = (day: string) => weekIndex(day) >= 5;

const cellBase: React.CSSProperties = {
  height: 46,
  /**
   * ★ 边框必须写成长写，不能用 `border` 简写 ★
   * 各状态只覆盖 borderColor。格子从「已标记」变回「未标记」时，
   * React 要删掉 borderColor，而 border 简写还在——简写与长写混用，
   * React 会报 "Removing a style property during rerender"，
   * 而且真的可能留下上一次的边框色。
   */
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'transparent',
  borderRadius: 'var(--r-md)',
  fontSize: 'var(--fs-md)',
  lineHeight: '44px',
  textAlign: 'center',
  cursor: 'pointer',
  padding: 0,
  background: 'transparent',
  fontFamily: 'inherit',
};

function MonthHead({
  month,
  onShift,
  onToday,
}: {
  month: string;
  onShift: (delta: number) => void;
  onToday: () => void;
}) {
  const [y, m] = month.split('-');
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
      <button type="button" className="pager-btn" onClick={() => onShift(-1)} aria-label="上个月">
        ‹
      </button>
      <b className="small" style={{ minWidth: 104, textAlign: 'center' }}>
        {y} 年 {Number(m)} 月
      </b>
      <button type="button" className="pager-btn" onClick={() => onShift(1)} aria-label="下个月">
        ›
      </button>
      <button type="button" className="pager-btn" onClick={onToday} style={{ marginLeft: 'auto' }}>
        今天
      </button>
    </div>
  );
}

function Grid({
  month,
  today,
  render,
  onPick,
  disabled,
  readOnly,
}: {
  month: string;
  today: string;
  render: (day: string) => { style: React.CSSProperties; title: string; text?: string };
  onPick: (day: string) => void;
  disabled?: boolean;
  /**
   * ★ 只读和 disabled 不是一回事 ★（2026-08-22）
   * disabled 是「这张日历现在点不了」（没选人），要画成半透明提醒他先选人；
   * 只读是「这个人本来就不该改」（业务员看主管排的班），颜色必须照常——
   * 他要看的正是哪几天放假、哪几天是他的请假。
   */
  readOnly?: boolean;
}) {
  const days = useMemo(() => daysOfMonth(month), [month]);
  const lead = weekIndex(days[0]!);
  return (
    // ★ 列宽用 1fr 不用固定 px ★ 固定宽度的话，日历永远是 250px 一小块缩在左边，
    // 右边空一大片；用 1fr 才会跟着栏位撑满
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
      {WEEK.map((w) => (
        <div key={w} className="tiny faint" style={{ textAlign: 'center', paddingBottom: 4 }}>
          {w}
        </div>
      ))}
      {Array.from({ length: lead }, (_, i) => (
        <div key={`pad-${i}`} />
      ))}
      {days.map((day) => {
        const look = render(day);
        return (
          <button
            key={day}
            type="button"
            title={look.title}
            disabled={disabled || readOnly}
            onClick={() => onPick(day)}
            style={{
              ...cellBase,
              ...look.style,
              cursor: readOnly ? 'default' : disabled ? 'not-allowed' : 'pointer',
              opacity: disabled && !readOnly ? 0.45 : 1,
              ...(day === today ? { outline: '1.5px solid var(--accent)', outlineOffset: -1 } : {}),
            }}
          >
            {look.text ?? Number(day.slice(8))}
          </button>
        );
      })}
    </div>
  );
}

/** 留档体检的结果。四种原因见 lib/ledger-audit.ts */
interface Audit {
  /** 最早那个异常日，也是重算起点。null = 没问题 */
  from: string | null;
  dayCount: number;
  sampleDays: string[];
  byReason: { REST_DAY: number; ON_LEAVE: number; CHAIN_BROKEN: number; RULE_CHANGED: number };
}

export default function CalendarBoard({
  today,
  marks,
  leaves,
  interns,
  audit,
  readOnly = false,
}: {
  today: string;
  marks: Mark[];
  leaves: Leave[];
  /** note 非空 = 这人已经不在册了（已停用/已转正），只为让他的历史请假撤得掉 */
  interns: Array<{ name: string; code: string; note: string }>;
  audit: Audit;
  /**
   * ★ 业务员看的是同一张日历，但一个格子都不能点 ★（2026-08-22 王老师定）
   * 假期与调休由主管维护，请假也由主管标——业务员只需要知道结果：
   * 哪几天不上班、他自己哪几天请了假。所以这里不做「隐藏」，做「只读」：
   * 少给他一张日历，他就得靠问人；给他一张点不动的，他自己看得见。
   */
  readOnly?: boolean;
}) {
  const thisMonth = today.slice(0, 7);
  const [holidayMonth, setHolidayMonth] = useState(thisMonth);
  const [leaveMonth, setLeaveMonth] = useState(thisMonth);
  const [who, setWho] = useState(interns[0]?.code ?? '');
  const [reason, setReason] = useState(REASONS[0]!);
  const [pending, start] = useTransition();

  const markOf = useMemo(() => new Map(marks.map((m) => [m.day, m.isWorkday])), [marks]);
  const leaveOf = useMemo(
    () => new Map(leaves.map((l) => [`${l.code}|${l.day}`, l.reason ?? '请假'])),
    [leaves],
  );

  /** 这一天实际上不上班？先看例外，没有就走默认 */
  const worksOn = (day: string) => markOf.get(day) ?? !isWeekend(day);

  const pickHoliday = (day: string) => {
    const next = !worksOn(day);
    // 和默认一样就把例外删掉——日历表只存例外
    const backToDefault = next === !isWeekend(day);
    start(() => {
      void setCalendarDay(day, backToDefault ? null : next);
    });
  };

  const pickLeave = (day: string) => {
    if (!who) return;
    const has = leaveOf.has(`${who}|${day}`);
    start(() => {
      void setLeaveDay(who, day, has ? null : reason);
    });
  };

  const lastMark = marks.length > 0 ? marks[marks.length - 1]!.day : null;

  return (
    <div style={{ opacity: pending ? 0.6 : 1, transition: 'opacity .12s' }}>
      {/* ★ 四种原因分开说 ★（2026-08-22）要做的动作是同一个（从最早那天起重算），
          但读的人得知道为什么——「他请假那天还挂着判定」和「链条断了」
          是完全不同的两件事，混成一句「留档过期」，下次就不会有人认真看了。 */}
      {!readOnly && audit.from !== null && (
        <div className="card" style={{ borderColor: 'var(--bad)', marginBottom: 14 }}>
          <div className="small">
            <b style={{ color: 'var(--bad)' }}>有 {audit.dayCount} 天的历史留档和当前口径对不上</b>
            <span className="faint" style={{ marginLeft: 8 }}>
              {audit.sampleDays.join('、')}
              {audit.dayCount > audit.sampleDays.length && ' …'}
            </span>
          </div>
          <div className="tiny" style={{ marginTop: 6, lineHeight: 1.9 }}>
            {audit.byReason.REST_DAY > 0 && (
              <div>
                · <b>{audit.byReason.REST_DAY} 条</b>落在<b>现在标着放假／周末</b>的日子上，
                库里却还留着当时按「工作日」算出来的判定。
              </div>
            )}
            {audit.byReason.ON_LEAVE > 0 && (
              <div>
                · <b>{audit.byReason.ON_LEAVE} 条</b>落在<b>他请假</b>的日子上。
                <span className="faint">
                  台账那一行被「请假」挡住了看不见，但这条判定还活着——连续不达标天数、
                  次日横幅、他自己首页的历史记录都还在读它。
                </span>
              </div>
            )}
            {audit.byReason.CHAIN_BROKEN > 0 && (
              <div>
                · <b>{audit.byReason.CHAIN_BROKEN} 条</b>的<b>连续不达标天数和前一天对不上</b>。
                <span className="faint">
                  多半是撤了假期／撤了请假／把周末标成了调休上班——中间补进来一天，
                  它之后那些日子的连续天数不会自己重算。
                </span>
              </div>
            )}
            {audit.byReason.RULE_CHANGED > 0 && (
              <div>
                · <b>{audit.byReason.RULE_CHANGED} 条</b>是按<b>老的判定口径</b>算出来的。
                <span className="faint">
                  阈值或窗口改过（中位数门槛、窗口天数、启用了哪几条），但这些留档没跟着重算——
                  于是台账上左边的格子按新规则摆、右边的结论按老规则给，两边都看着正常。
                </span>
              </div>
            )}
          </div>
          <div className="tiny faint" style={{ marginTop: 8, lineHeight: 1.8 }}>
            重算会按当前日历把 {audit.from} 起到昨天为止重跑一遍，<b>会真的改期别与分配权</b>——
            先确认日历标对了再点。一次最多重算 40 个业务日，没跑完的话再点一次。
          </div>
          <button
            type="button"
            className="pager-btn"
            style={{ marginTop: 8 }}
            onClick={() => start(() => void resettleFrom(audit.from!))}
          >
            从 {audit.from} 起重算
          </button>
        </div>
      )}

      {/* ★ 两栏等分、各撑满一半 ★ 原来是 flex + minWidth:250，两张日历会挤在左边、
          右边空一大片。改成 auto-fit 网格：宽屏一行两栏平分，窄屏自动落成上下两行。 */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
          gap: '30px 48px',
        }}
      >
        {/* ── 公司放假 ── */}
        <div style={{ minWidth: 0, maxWidth: 620 }}>
          <div className="subsection-title" style={{ marginTop: 0 }}>
            公司放假 · 调休
          </div>
          <MonthHead
            month={holidayMonth}
            onShift={(d) => setHolidayMonth(shiftMonth(holidayMonth, d))}
            onToday={() => setHolidayMonth(thisMonth)}
          />
          <Grid
            month={holidayMonth}
            today={today}
            readOnly={readOnly}
            onPick={pickHoliday}
            render={(day) => {
              const marked = markOf.get(day);
              const works = worksOn(day);
              if (marked === false)
                return {
                  title: `${day} 放假（已标记，点一下取消）`,
                  style: {
                    background: 'color-mix(in srgb, var(--warn) 18%, transparent)',
                    color: 'var(--warn)',
                    fontWeight: 700,
                    borderColor: 'color-mix(in srgb, var(--warn) 40%, transparent)',
                  },
                };
              if (marked === true)
                return {
                  title: `${day} 调休上班（已标记，点一下取消）`,
                  style: {
                    background: 'color-mix(in srgb, var(--ok) 18%, transparent)',
                    color: 'var(--ok)',
                    fontWeight: 700,
                    borderColor: 'color-mix(in srgb, var(--ok) 40%, transparent)',
                  },
                };
              return works
                ? { title: `${day} 上班（默认）· 点一下标成放假`, style: {} }
                : {
                    title: `${day} 周末休息（默认）· 点一下标成调休上班`,
                    style: { background: 'var(--panel-2)', color: 'var(--faint)' },
                  };
            }}
          />
          <div className="tiny faint" style={{ marginTop: 10, lineHeight: 1.8 }}>
            {/* ★ 只读模式只留一行 ★（2026-08-23 王老师定）颜色不说明就看不懂，
                但除了「那几天不算我缺考」之外，其余都不必解释。 */}
            {readOnly ? (
              <>黄 = 放假、绿 = 调休上班。放假那天<b>不算你缺考</b>。</>
            ) : (
              <>
                点一下切换。周一至周五默认上班、周末默认休息，
                <b>点周末就是调休上班</b>，不用另设一个功能。
                <br />
                标了放假的日子<b>整天从判定里消失</b>：台账没有那一行，也不在任何人的判定窗口里留空格。
                <br />
              </>
            )}
            {lastMark ? (
              <>
                最后标记到 <b className="num">{lastMark}</b>
                {lastMark < today && <b style={{ color: 'var(--bad)' }}> —— 都是过去的，该排下一段假了</b>}
              </>
            ) : (
              <b style={{ color: 'var(--bad)' }}>一天都没标 —— 国庆、春节会被当成工作日</b>
            )}
          </div>
        </div>

        {/* ── 个人请假 ── */}
        <div style={{ minWidth: 0, maxWidth: 620 }}>
          <div className="subsection-title" style={{ marginTop: 0 }}>
            {readOnly ? '我的请假 · 出差' : '个人请假 · 出差'}
          </div>
          {/* 只读模式下人只有他自己、事由是主管填的——两个下拉都没有意义 */}
          <div style={{ display: readOnly ? 'none' : 'flex', gap: 8, marginBottom: 8 }}>
            {/* ★ flex-basis 必须写 0 ★ globals.css 里有 `select { width: 100% }`，
                不覆盖的话事由框会按 100% 撑开，把人员框挤成一个箭头 */}
            <select
              className="small"
              value={who}
              onChange={(e) => setWho(e.target.value)}
              style={{ padding: '6px 8px', flex: '2 1 0', minWidth: 0 }}
            >
              {interns.length === 0 && <option value="">（没有实习业务员）</option>}
              {interns.map((person) => (
                <option key={person.code} value={person.code}>
                  {person.name}
                  {person.note && `（${person.note}）`}
                </option>
              ))}
            </select>
            <select
              className="small"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              style={{ padding: '6px 8px', flex: '1 1 0', minWidth: 0 }}
            >
              {REASONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <MonthHead
            month={leaveMonth}
            onShift={(d) => setLeaveMonth(shiftMonth(leaveMonth, d))}
            onToday={() => setLeaveMonth(thisMonth)}
          />
          <Grid
            month={leaveMonth}
            today={today}
            disabled={!who}
            readOnly={readOnly}
            onPick={pickLeave}
            render={(day) => {
              const mine = leaveOf.get(`${who}|${day}`);
              if (mine)
                return {
                  title: `${day} ${mine}（点一下取消）`,
                  style: {
                    background: 'color-mix(in srgb, var(--warn) 18%, transparent)',
                    color: 'var(--warn)',
                    fontWeight: 700,
                    borderColor: 'color-mix(in srgb, var(--warn) 40%, transparent)',
                  },
                };
              // 公司已经放假的日子不必再请假，画淡一点免得白点
              if (!worksOn(day))
                return {
                  title: `${day} 公司放假，不用请假`,
                  style: { background: 'var(--panel-2)', color: 'var(--faint)' },
                };
              return { title: `${day} 点一下标成「${reason}」`, style: {} };
            }}
          />
          <div className="tiny faint" style={{ marginTop: 10, lineHeight: 1.8 }}>
            {readOnly ? (
              <>黄 = 主管替你标的请假／出差，那几天<b>不算你缺考</b>。</>
            ) : (
              <>
                先选人和事由，再点日期。那几天<b>只对这个人</b>不是业务日。
                <br />
                台账那一行写<b>「请假」</b>而不是「缺考」—— 一个是批过的，一个是没来，
                不能在台账上留同样的痕迹。
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
