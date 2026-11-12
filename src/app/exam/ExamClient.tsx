'use client';

import { useCallback, useEffect, useState } from 'react';
import { fmt, type WindowSlot, type WindowVerdict } from '@/lib/admission-v11';
import Pager, { PAGE_SIZE } from '@/components/Pager';
import Icon from '@/components/Icon';
import EmptyState from '@/components/EmptyState';

/**
 * ★ 系统只创建 DAILY 一种考试 ★（v1.1 起）
 * 这里原来还列着 LEGACY / ADMISSION_1 / ADMISSION_2 / MAINTENANCE / RETEST 五种，
 * 连同它们的「五道闸门」展示块一起，于 2026-08-24 随 v2.0/v3.0 判定路径删除。
 * 库表的 enum 保留着那几个值（不值得为空数据跑一次迁移），所以这里按未知值兜底显示。
 */
type AttemptType = 'DAILY' | (string & {});

interface Attempt {
  id: string;
  day: string;
  businessDay: string | null;
  attemptType: AttemptType;
  sessionIds: string[];
  verdict: string | null;
  passed: boolean | null;
  conclusion: string | null;
  scoreRuleVersion: string;
  poolVersion: string;
  user: { name: string };
}

interface SessionInfo {
  sessionType: 'INQUIRY' | 'FOLLOWUP';
  difficulty: string;
  status: 'ACTIVE' | 'ENDED';
  turn: number;
  scored: boolean;
  rawScore: number | null;
  tier: string | null;
}

interface Config {
  /** 窗口跨几个业务日。★ 别再只说「6 局」★ 见 admission-v11.ts 顶上那段 */
  windowDays: number;
  sessionsPerExam: number;
  windowSessions: number;
  medianScoreMin: number;
  insightMedianMin: number;
  answerQualityMedianMin: number;
  dailyDrillMin: number;
  consecutiveFailsToSuspend: number;
}

/** 今天还能不能开考。★ 和 POST 读同一份判断 ★ 见 api/exam/route.ts 的 examGate */
interface ExamGate {
  canStart: boolean;
  reason: string;
}

interface Unlock {
  done: number;
  required: number;
  unlocked: boolean;
  /** 这几局里有几局不是简单局（2026-08-23 起解锁的第二道条件） */
  nonSimpleDone: number;
  nonSimpleRequired: number;
  text: string;
}

/** 周考轨的本周进度。字段跟着 lib/weekly-exam.ts 的 WeekVerdict 走 */
interface WeekView {
  weekStart: string;
  weekEnd: string;
  examCount: number;
  preciseCount: number;
  medianScore: number | null;
  met: boolean | null;
  examGap: number;
  scoreOk: boolean | null;
  detail: string;
  examDays: string[];
}

interface WeeklyConfig {
  examsPerWeek: number;
  sessionsPerExam: number;
  sessionsPerWeek: number;
  medianScoreMin: number;
}

/** 身份的人话。页面上不该出现 REGULAR / WEEKLY_EXAM 这种枚举原文 */
const EMPLOYEE_LABEL: Record<string, string> = {
  INTERN: '实习业务员',
  REGULAR: '正式业务员',
  MANAGER: '管理员',
  OTHER: '其他',
};
const MODE_LABEL: Record<string, string> = {
  ADMISSION: '走准入考试',
  WEEKLY_EXAM: '走周考',
  NONE: '不参加考核',
};

const TYPE_LABEL: Record<string, string> = {
  DAILY: '每日考试',
};

function stageOf(info: SessionInfo | undefined) {
  if (!info) return { label: '—', action: null as null | 'play' | 'report' };
  if (info.scored) return { label: '已出分', action: 'report' as const };
  if (info.status === 'ENDED') return { label: '已结束 · 待评分', action: 'play' as const };
  if (info.turn > 0) return { label: `进行中 · 第 ${info.turn} 轮`, action: 'play' as const };
  return { label: '未开始', action: 'play' as const };
}

export default function ExamClient() {
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [sessions, setSessions] = useState<Record<string, SessionInfo>>({});
  const [identity, setIdentity] = useState<{
    employeeType: string;
    participationMode: string;
    stage: string;
    /** 他走哪条考试轨。'ADMISSION'=准入（实习）｜'WEEKLY'=周考（正式）｜null=不参加 */
    track: 'ADMISSION' | 'WEEKLY' | null;
  } | null>(null);
  // 周考轨的本周进度。准入轨为 null，两条轨各读各的，不互相顶
  const [week, setWeek] = useState<WeekView | null>(null);
  const [weeklyConfig, setWeeklyConfig] = useState<WeeklyConfig | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [unlock, setUnlock] = useState<Unlock | null>(null);
  const [gate, setGate] = useState<ExamGate | null>(null);
  // 判定窗口（最近 2 个业务日 6 局）。接口早就在返回了，页面一直没用——
  // 显示屏要靠它画那 6 个格子，缺考的格子必须空着。
  const [judge, setJudge] = useState<WindowVerdict | null>(null);
  const [today, setToday] = useState<string | null>(null);
  // ★ 今天这场由接口单独给 ★ 记录分页之后，今天那场可能根本不在当页的 attempts 里
  const [todayExam, setTodayExam] = useState<{ state: 'none' | 'running' | 'done'; scored: number; total: number } | null>(null);
  // 考试记录的翻页。一页 10 场，翻页是重新请求，不在前端切片
  // 首屏还没拿到身份时，什么都别断言——不然业务员会先看到一句「这个账号没有开考入口」
  const [loaded, setLoaded] = useState(false);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [viewingAll, setViewingAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);

  const load = useCallback(async (which: number = page) => {
    const response = await fetch(`/api/exam?page=${which}`, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) {
      setMessage({ text: data.error ?? '加载失败', bad: true });
      return;
    }
    setAttempts(data.attempts ?? []);
    setSessions(data.sessionInfo ?? {});
    setIdentity(data.identity ?? null);
    setConfig(data.config ?? null);
    setUnlock(data.unlock ?? null);
    setGate(data.gate ?? null);
    setJudge(data.window ?? null);
    setWeek(data.week ?? null);
    setWeeklyConfig(data.weeklyConfig ?? null);
    setToday(data.today ?? null);
    setTodayExam(data.todayExam ?? null);
    setTotal(data.attemptsTotal ?? 0);
    // 删记录、筛掉一页之后别停在空白页——接口把夹好的页码回传，页面跟着它走
    if (typeof data.page === 'number' && data.page !== which) setPage(data.page);
    setViewingAll(Boolean(data.viewingAll));
    setLoaded(true);
  }, []);

  useEffect(() => {
    void load(page);
  }, [load, page]);

  async function start() {
    setBusy(true);
    setConfirming(false);
    setMessage(null);
    try {
      const response = await fetch('/api/exam', { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? '开考失败');
      setMessage({ text: data.poolInfo ?? (data.resumed ? '已恢复今天这场没打完的考试。' : '今天的考试已开好 3 局。') });
      setPage(1);
      await load(1);
    } catch (error) {
      setMessage({ text: (error as Error).message, bad: true });
    } finally {
      setBusy(false);
    }
  }

  async function settle(attemptId: string) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch('/api/exam', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ attemptId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? '交卷失败');
      await load();
    } catch (error) {
      setMessage({ text: (error as Error).message, bad: true });
    } finally {
      setBusy(false);
    }
  }

  /**
   * ★ 2026-08-24：状态屏对两条轨都开 ★
   * 原来这里写死「实习业务员 + 准入」，正式业务员看到的是一句
   * 「这个账号没有开考入口」——而他现在每周要考两场。
   */
  const track = identity?.track ?? null;
  const admissionUser = track === 'ADMISSION';
  const weeklyUser = track === 'WEEKLY';
  /** 有开考入口的人。状态屏、开考按钮、空态文案都读它 */
  const examUser = track !== null;
  const training = identity?.stage === 'TRAINING';
  const blocked = Boolean(admissionUser && training && unlock && !unlock.unlocked);
  // ★ 一天一场，考完就锁 ★ 能不能开考由接口说了算，按钮不自己算一套
  const canStart = Boolean(gate?.canStart);

  // ── 今天这场考到哪一步了 ──
  // ★ 数已出分的局，不读 attempt.verdict ★ 和 admission-v11.todayExamState 同一个口径：
  // verdict 是评完第三局时自动交卷写上去的，那一步允许失败，读它会把「考完了」说成「没考」。
  // ★ 这份数据由接口单独查 ★ 记录列表是分页的，翻到第 2 页时今天那场不在里面。
  const todayCell =
    !todayExam || todayExam.state === 'none'
      ? { v: '未考', sub: '' }
      : todayExam.state === 'running'
        ? { v: `${todayExam.scored} / ${todayExam.total} 局已出分`, sub: '这场还没打完' }
        : { v: '已考完', sub: '明天再来' };

  /**
   * 样本不够时，一句话说清缺在哪。
   * ★ 只说事实，不带规则 ★ 「缺的局补不回来」「连着考满两天才重新达标」这类
   * 是规则，写在考前必读里；这里是状态屏，只回答「现在缺什么」。
   */
  const missedDays = (judge?.missingByDay ?? []).filter((item) => item.day !== today);
  const todayMissing = (judge?.missingByDay ?? []).find((item) => item.day === today);
  const windowNote = !judge
    ? ''
    : missedDays.length > 0
      ? `${missedDays.map((item) => item.day.slice(5)).join('、')} 缺考`
      : todayMissing
        ? `今天还差 ${todayMissing.missing} 局`
        : judge.preciseCount < judge.sampleCount
          ? '有局没评出分'
          : '';

  // 判定窗口那 6 格，按业务日分组摆出来：左边前一个业务日，右边今天
  const slotDays: Array<{ day: string; sameDay: boolean; slots: WindowSlot[] }> = [];
  for (const slot of judge?.slots ?? []) {
    const last = slotDays[slotDays.length - 1];
    if (last && last.day === slot.day) last.slots.push(slot);
    else slotDays.push({ day: slot.day, sameDay: slot.sameDay, slots: [slot] });
  }

  return (
    <>
      {/* ── 页头 ── */}
      <div className="page-head">
        {/* ★ 标题底下那两行副标题已于 2026-08-27 删除 ★
            它们说的话下面都已经说过了，而且说得更具体：
              · 「正式业务员 · 每周至少 2 场（6 局）」
                → KPI 第一格就是「本周考试 0/2 场 · 还差 2 场」，
                  那里带着**他现在考到第几场**，比这句干巴巴的要求有用。
              · 「主管视图 · 全员考试记录」
                → 底下「这个账号没有开考入口」那张卡整段在讲这件事，
                  再往下「考试记录」标题旁边还写着「全员 · 27 场」。同一句话摆了三遍。
            页标题底下挂一行说明，看着像在交代什么，实际只是把下面的话提前念一遍。 */}
        <h1>考试闸门</h1>
        {/* ★ 和「这页怎么用」同一套外观 ★（2026-08-27）
            它们是同一类东西——都是「去看说明」，不是「做一件事」。
            原来它长得像一个普通操作按钮，和「去考试闸门」那种真动作按钮同一个重量。
            现在统一成书图标 + 一句话的胶囊：全站看见这个形状就知道点开是说明。 */}
        <a href="/exam/intro" className="page-help-btn page-head-right">
          <Icon name="book" size={14} />
          <span>考前必读</span>
        </a>
      </div>

      {/* ── 今日准入状态屏 ──（2026-08-22 王老师定）
          ★ 这一页只放「他现在处于什么状态」，规则一律去考前必读 ★
          原来这里摊着一整套考试规则，和考前必读讲的是同一件事、同一套口径——
          一份规则挂两处，迟早对不上；而且每天来开考的人要滚过整页规则才找得到按钮。
          规则是查一次记住的东西，状态是每天都要看的东西，两者不该挤在一屏。 */}
      {examUser && config && (
        <>
          <div className="kpis section-block">
            {/* ★ 第一格问的是「我现在按哪套要求走」★ 两条轨答的不是同一个问题：
                准入轨答期别（有没有询盘分配权），周考轨答本周还差几场。 */}
            {weeklyUser && weeklyConfig ? (
              <div className="kpi">
                <div className="section-label" style={{ margin: 0 }}>本周考试</div>
                <div
                  className="v"
                  style={{ color: week?.met === true ? 'var(--ok)' : undefined }}
                >
                  {week?.examCount ?? 0} / {weeklyConfig.examsPerWeek} 场
                </div>
                <div className="tiny faint" style={{ marginTop: 3 }}>
                  {week?.met === true ? '本周已考满' : `还差 ${week?.examGap ?? weeklyConfig.examsPerWeek} 场`}
                </div>
              </div>
            ) : (
              <div className="kpi">
                <div className="section-label" style={{ margin: 0 }}>当前阶段</div>
                <div className="v">{training ? '训练期' : '在岗期'}</div>
                <div className="tiny faint" style={{ marginTop: 3 }}>
                  {training ? '没有新询盘分配权' : '分配权正常'}
                </div>
              </div>
            )}

            <div className="kpi">
              <div className="section-label" style={{ margin: 0 }}>今日演习</div>
              <div
                className="v"
                /* ★ 只有准入轨的训练期才染色 ★ 周考轨这一格写的是「不要求」，
                   跟着 stage 染成橙色会让正式业务员以为自己欠着什么 */
                style={{
                  color:
                    admissionUser && training ? (unlock?.unlocked ? 'var(--ok)' : 'var(--warn)') : undefined,
                }}
              >
                {admissionUser && training
                  ? `${unlock?.done ?? 0} / ${unlock?.required ?? config.dailyDrillMin} 局`
                  : '不要求'}
              </div>
              {weeklyUser && (
                /* ★ 周考轨不设「先练 3 局才解锁」★（2026-08-24 王老师定）
                    那道闸是逼训练期的实习生每天刻意练习；正式业务员的要求是每周 2 场，
                    练不练由他自己定。 */
                <div className="tiny faint" style={{ marginTop: 3 }}>
                  练习不限次数、不计分
                </div>
              )}
              {admissionUser && training && (
                <div className="tiny faint" style={{ marginTop: 3 }}>
                  {/* ★ 局数满了却没解锁时，这行必须说难度 ★（2026-08-23）
                      写「练够才解锁考试」会跟上面的 3 / 3 直接打架。 */}
                  {unlock?.unlocked
                    ? '考试已解锁'
                    : unlock && unlock.done >= unlock.required
                      ? `还差 ${unlock.nonSimpleRequired - unlock.nonSimpleDone} 局标准或困难`
                      : '练够才解锁考试'}
                </div>
              )}
            </div>

            <div className="kpi">
              <div className="section-label" style={{ margin: 0 }}>今天这场</div>
              <div className="v">{todayCell.v}</div>
              {todayCell.sub && <div className="tiny faint" style={{ marginTop: 3 }}>{todayCell.sub}</div>}
            </div>

            {/* ★ 必须写「考试」两个字 ★（2026-08-23 王老师定）只写「最近 6 局」，
                看的人会以为模拟询盘那些局也算进来了——演习一局都不进这个窗口。
                ★ 两条轨的分母不一样，标签必须各说各的 ★ 准入轨是「最近 6 局」
                （跨 2 个业务日滚动），周考轨是「本周 6 局」。两个数长得一样，
                不标口径就没人分得出这 68 分是按哪套算的。 */}
            {weeklyUser && weeklyConfig ? (
              <div className="kpi">
                <div className="section-label" style={{ margin: 0 }}>本周 {weeklyConfig.sessionsPerWeek} 局考试中位数</div>
                <div
                  className="v"
                  style={{ color: week?.scoreOk === true ? 'var(--ok)' : undefined }}
                >
                  {week?.medianScore === null || week?.medianScore === undefined
                    ? '—'
                    : fmt(week.medianScore)}
                </div>
                <div className="tiny faint" style={{ marginTop: 3 }}>
                  {/* ★ 这里说「参考线」不说「门槛」★ 周考不卡任何权限，
                      写成门槛会让他以为没到就要出事 */}
                  {week && week.preciseCount > 0
                    ? `已出分 ${week.preciseCount}/${weeklyConfig.sessionsPerWeek} 局 · 参考线 ${weeklyConfig.medianScoreMin}`
                    : '还没有出分的局'}
                </div>
              </div>
            ) : (
              <div className="kpi">
                <div className="section-label" style={{ margin: 0 }}>最近 {config.windowSessions} 局考试中位数</div>
                <div
                  className="v"
                  style={{
                    color:
                      judge?.enough && judge.passed === true
                        ? 'var(--ok)'
                        : judge?.enough && judge.passed === false
                          ? 'var(--bad)'
                          : undefined,
                  }}
                >
                  {judge?.enough ? fmt(judge.medianScore ?? 0) : '—'}
                </div>
                <div className="tiny faint" style={{ marginTop: 3 }}>
                  {judge?.enough
                    ? judge.passed
                      ? `达标 · 门槛 ${config.medianScoreMin}`
                      : `差 ${fmt(judge.scoreGap)} 分`
                    : '样本没齐'}
                </div>
              </div>
            )}
          </div>

          {/* ── 一行两格：左边「今天能不能考」，右边「判定窗口」──
              （2026-08-23 王老师定）这两块原来是上下两张通栏卡片：
              判定窗口那张只有六个小格子，右边空着一大片；开考那张只有一行字加一个按钮。
              合成一行两格之后，一屏之内左边是要做的事、右边是判定进度，不用往下滚。
              ★ 和上面四格用同一种方框 ★ 视觉上是同一层东西，不该有两种卡片样式。 */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
              gap: 14,
              marginTop: 14,
            }}
          >
            {/* 左：能不能考 + 按钮，上下结构。
                ★ 判断只有一份 ★ 按钮亮不亮、这句话怎么写，都读接口给的 gate，
                页面不自己算一套（不然会出现「按钮亮着、点下去说考完了」）。 */}
            <div
              className="card"
              style={{
                borderColor: canStart ? 'var(--ok)' : 'var(--line)',
                display: 'flex',
                flexDirection: 'column',
                // 和右边那格、和上面四格一样：内容居中
                alignItems: 'center',
                justifyContent: 'center',
                textAlign: 'center',
                gap: 14,
              }}
            >
              <b className="with-ico" style={{ fontSize: 'var(--fs-base)', color: canStart ? 'var(--ok)' : 'var(--text)' }}>
                <Icon name={canStart ? 'check' : 'lock'} size={15} />
                {canStart ? '今天这场可以开考' : (gate?.reason ?? '读取中…')}
              </b>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                {confirming ? (
                  <>
                    <button className="primary" onClick={start} disabled={busy}>
                      {busy ? '创建中…' : '确认开始今天这场'}
                    </button>
                    <button onClick={() => setConfirming(false)} disabled={busy}>取消</button>
                  </>
                ) : (
                  <button className="primary" onClick={() => setConfirming(true)} disabled={busy || !canStart}>
                    开始今天的考试
                  </button>
                )}
              </div>
            </div>

            {/* 右：判定窗口，整块居中。
                ★ 缺考的格子必须空着 ★ 不画格子的话，「昨天考了 3 局」和
                「昨天没考、拿更早的分顶上」在页面上长得一模一样。 */}
            {/* 周考轨：右边这格摆「本周考了哪几天」。
                ★ 不画准入那六个格子 ★ 那六格是排死的「判定日 + 前一业务日 × 3 局」，
                空格＝缺考；周考没有「哪天必须考」这回事，硬画会凭空造出缺考的意思。 */}
            {weeklyUser && week && weeklyConfig && (
              <div
                className="card"
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 10,
                  textAlign: 'center',
                }}
              >
                <b className="small">
                  本周 · {week.weekStart.slice(5)} 至 {week.weekEnd.slice(5)}
                </b>
                <div className="small">
                  {week.examDays.length > 0 ? (
                    <>
                      考了 <b className="num">{week.examDays.length}</b> 天（
                      {week.examDays.map((day) => day.slice(5)).join('、')}）
                    </>
                  ) : (
                    <span className="muted">这周还没考过</span>
                  )}
                </div>
                <div className="small muted" style={{ lineHeight: 1.8 }}>{week.detail}</div>
              </div>
            )}

            {admissionUser && judge && (
              <div
                className="card"
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 10,
                }}
              >
                <b className="small">判定窗口 · 最近 {config.windowSessions} 局考试</b>
                <div className="wingrid" style={{ marginTop: 0, justifyContent: 'center' }}>
                  {slotDays.map((group) => (
                    <div className="wday" key={group.day}>
                      {/* ★ 标签只说日期 ★（2026-08-23）原来非今天的一律写「上一个业务日」，
                          周六打开时窗口里两天都不是今天，页面上就并排挂着两个「上一个业务日」。 */}
                      <div className="wday-label" style={{ textAlign: 'center' }}>
                        {group.sameDay ? `今天 · ${group.day.slice(5)}` : group.day.slice(5)}
                      </div>
                      <div className="wcells">
                        {group.slots.map((slot) => {
                          const score = slot.session?.rawScore ?? null;
                          const text =
                            score !== null ? fmt(score) : slot.session ? '?' : group.sameDay ? '·' : '—';
                          return (
                            <span
                              key={`${slot.day}-${slot.nth}`}
                              className={score !== null ? 'wcell' : 'wcell empty'}
                            >
                              {text}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
                {/* ★ 这里只说「缺在哪」★（2026-08-23 王老师定）
                    样本够的时候上面第四格已经把中位数和差几分说完了，这里再说一遍是重复；
                    规则（缺的局补不回来、连着考满两天）在考前必读里。 */}
                {!judge.enough && windowNote && <div className="small muted">{windowNote}</div>}
              </div>
            )}
          </div>
        </>
      )}

      {/* ── 没有开考入口的账号，得告诉他为什么 ──（2026-08-22）
          ★ 「什么都不显示」会被读成「功能坏了」★ 主管账号从来就不能开考
          （POST /api/exam 对非准入身份直接 403），可页面上什么都不说，
          看起来就像考试入口丢了。空白不是解释。 */}
      {loaded && !examUser && (
        <div className="card section-block" style={{ background: 'var(--panel-2)' }}>
          <b className="small">这个账号没有开考入口</b>
          <div className="small muted" style={{ marginTop: 6, lineHeight: 1.9 }}>
            考试对<b>实习业务员</b>和<b>正式业务员</b>的账号开放
            {identity ? `——你当前的身份是「${EMPLOYEE_LABEL[identity.employeeType] ?? identity.employeeType} · ${MODE_LABEL[identity.participationMode] ?? identity.participationMode}」` : ''}。
            <br />
            业务员自己登录后，这里会显示<b>今日状态屏</b>（能不能考、考到哪一步、最近几局判成什么样）和
            <b>「开始今天的考试」</b>按钮。
            {viewingAll && (
              <>
                <br />
                你这个账号能看<b>全员考试记录</b>——就在下面，包括每一局的分数和报告。
              </>
            )}
          </div>
        </div>
      )}

      {message && (
        <div className="card small" style={{ marginTop: 12, color: message.bad ? 'var(--bad)' : 'var(--ok)', whiteSpace: 'pre-wrap' }}>
          {message.text}
        </div>
      )}

      {/* ── 考试记录 ──（2026-08-22 王老师定：分页 + 折叠）
          ★ 一场一张卡，默认折叠 ★ 主管翻的是全员记录，展开着一屏放不下两张卡，
          要找某一天得一路滚。标题行（谁 · 哪天 · 什么状态）留在外面，明细点开才看。
          ★ 「进行中」那场例外，默认展开 ★ 那是他今天还要接着打的东西，不该藏起来。
          ★ 分页在服务端 ★ 一页 10 场，翻页是重新请求，见 api/exam 的 RECORDS_PER_PAGE。 */}
      {total > 0 && (
        <div className="section-title">
          {viewingAll ? '考试记录' : '我的考试记录'}
          <span className="sub">
            {viewingAll ? '全员' : '只有我自己'} · <span className="num">{total}</span> 场
            {total > PAGE_SIZE && <> · 一页 {PAGE_SIZE} 场</>}
          </span>
        </div>
      )}

      {/* ★ 空态要说话 ★ 一场都没考过时整块不渲染，页面到状态屏就断了，
          看起来像「记录功能没给我」。业务员的记录列表本来就只有他自己的。 */}
      {total === 0 && examUser && (
        <div className="section-title">我的考试记录</div>
      )}
      {total === 0 && examUser && (
        <EmptyState
          title="你还没有考过。"
          hint="考完一场，这里会列出那一场的三局成绩、中位数和判定结果。"
          icon="target"
        />
      )}

      {attempts.map((attempt) => {
        const stage = attempt.sessionIds.map((id) => stageOf(sessions[id]));
        const scoredCount = stage.filter((item) => item.label === '已出分').length;
        const canSettle = scoredCount === attempt.sessionIds.length;
        /**
         * ★ 一场考试只给一个主按钮 ★（2026-08-27 王老师定：入口不够明显）
         * 三局的动作原来都是裸链接，和左边的状态字长得一样，看不出哪儿能点；
         * 可要是三局都摆成填色按钮，又等于没有重点。所以挑一个：
         *   ① 先挑**没打完**的（进行中 / 已结束待评分）——手上的活先收尾；
         *   ② 都没有，才挑第一局还没开始的。
         * 其余可点的局照样是按钮，只是描边款。
         * ★ 只在「进行中」的那场上挑 ★ 已经收掉的场次（SETTLED / EXPIRED）
         * 现在整排都不给入口了，见下面那处。
         *
         * 【订正】这里原来写着「跨天作废的那场点进去也不计数」——**这句是错的**。
         * 判定窗口（lib/settlement.ts 的 loadWindowSessions）按
         * `mode: 'ADMISSION_EXAM' + 有分` 捞局，根本不看所属场次的 verdict，
         * 作废场次里已经出分的局照样进窗口。这也正是接口那句
         * 「已经打完并出分的局照常进统计窗口，一局都不浪费」说的事——
         * 作废的是**继续作答的资格**，不是已经拿到的分。
         */
        const nextIdx =
          attempt.verdict !== null
            ? -1
            : stage.findIndex((item) => item.action === 'play' && item.label !== '未开始') >= 0
              ? stage.findIndex((item) => item.action === 'play' && item.label !== '未开始')
              : stage.findIndex((item) => item.action === 'play');
        const statusColor =
          attempt.verdict === null
            ? 'var(--warn)'
            : attempt.verdict === 'EXPIRED'
              ? 'var(--muted)'
              : 'var(--text)';
        /**
         * ★ 一场考试只有三种状态 ★（2026-08-24）
         * 这里原来还有 PENDING_REVIEW / INVALID / PASSED / FAILED 四支，
         * 分别来自 v2.0 的 judgeExam 与 v3.0 的双组判定——两套都已删除，
         * 现在只有 settleDailyAttempt 写 SETTLED、开考接口写 EXPIRED。
         * 「达标 / 未达标」不是一场考试的属性：判定看最近 6 局，在首页状态条上。
         */
        const statusText =
          attempt.verdict === null
            ? `进行中 · ${scoredCount}/${attempt.sessionIds.length} 局已出分`
            : attempt.verdict === 'SETTLED'
              ? '已交卷'
              : attempt.verdict === 'EXPIRED'
                ? '跨天作废 · 不计考试次数'
                : attempt.verdict;
        return (
          <details
            key={attempt.id}
            className="card section-fold"
            style={{ marginTop: 14, padding: '13px 18px' }}
            open={attempt.verdict === null}
          >
            <summary style={{ flexWrap: 'wrap' }}>
              <span>
                {attempt.user.name} · {TYPE_LABEL[attempt.attemptType] ?? attempt.attemptType} · {attempt.businessDay ?? attempt.day}
              </span>
              <span className="sub" style={{ marginLeft: 'auto', color: statusColor }}>{statusText}</span>
            </summary>

            <div className="tiny faint" style={{ marginTop: 10 }}>
              题池 {attempt.poolVersion} · 评分 {attempt.scoreRuleVersion}
            </div>

            <div style={{ display: 'grid', gap: 6, marginTop: 12 }}>
              {attempt.sessionIds.map((id, index) => {
                const info = sessions[id];
                const item = stage[index]!;
                return (
                  <div key={id} className="small" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span className="muted" style={{ width: 140 }}>
                      第 {index + 1} 局 · {info?.sessionType === 'FOLLOWUP' ? '跟进' : '探需'}
                      {info?.difficulty === 'hard' ? '·困难' : info?.difficulty === 'standard' ? '·标准' : ''}
                    </span>
                    <span style={{ minWidth: 110 }}>{item.label}</span>
                    {/* ★ 动作画成按钮，不是一行同样大小的字 ★（2026-08-27）
                        「未开始」和「开始」原来一个是状态、一个是入口，可它们并排着、
                        字号一样、都只有两三个字——除了颜色没有任何差别。
                        现在左边那个仍是状态，右边这个是按钮：下一局该打的填色，其余描边。
                        标签还是 <a>（要跳去 /drill/xxx，右键新开得留着），只是借了按钮的长相。 */}
                    {/* ★ 只有还在进行的那场才给入口 ★（2026-08-28）
                        这个条件原来只有 `item.action === 'play'`——它只问「这一局有没有分」，
                        不问「这场考试还算不算数」。于是昨天没考完那场今天照样能点
                        「继续/评分」，等于昨天的考试今天接着考（王老师 2026-08-28 报的）。
                        真正的闸在 lib/session-guard.ts（藏按钮拦不住直接开 URL 的人），
                        这里是不让人白点一下。 */}
                    {item.action === 'play' && attempt.verdict === null && (
                      <a href={`/drill/${id}`} className={index === nextIdx ? 'as-btn primary' : 'as-btn'}>
                        {item.label === '未开始' && <Icon name="play" size={13} />}
                        {item.label === '未开始' ? '开始这一局' : '继续/评分'}
                      </a>
                    )}
                    {/* 看报告不是动作，是回头看——留成链接，别跟上面那个抢 */}
                    {item.action === 'report' && (
                      <a href={`/report/${id}`}>看报告{typeof info?.rawScore === 'number' ? ` · ${info.rawScore} 分` : ''}</a>
                    )}
                  </div>
                );
              })}
            </div>

            {attempt.verdict === null && (
              <div style={{ marginTop: 12 }}>
                {/* 三局都出分时系统已自动交卷；这个按钮只是补一个手动入口。
                    ★ 交不交卷都不影响判定 ★ 每晚结算读的是局和分。 */}
                <button onClick={() => settle(attempt.id)} disabled={busy || !canSettle}>
                  手动交卷
                </button>
                {!canSettle && (
                  <span className="small muted" style={{ marginLeft: 10 }}>
                    还有 {attempt.sessionIds.length - scoredCount} 局没出分
                  </span>
                )}
              </div>
            )}

            {attempt.conclusion && (
              <div className="card small" style={{ marginTop: 12, background: 'var(--panel-2)', whiteSpace: 'pre-wrap' }}>
                {attempt.conclusion}
              </div>
            )}
          </details>
        );
      })}

      <Pager current={page} pageCount={Math.max(1, Math.ceil(total / PAGE_SIZE))} onChange={setPage} />
    </>
  );
}
