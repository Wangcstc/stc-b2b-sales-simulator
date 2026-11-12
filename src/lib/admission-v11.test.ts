import { describe, expect, it } from 'vitest';
import {
  ADMISSION_CONFIG,
  buildWindow,
  examStateOf,
  judgeWindow,
  statusLine,
  examGateOf,
  overrideStillActive,
  unlockState,
  type GateView,
  type WindowSession,
} from './admission-v11';
import { calendarFrom, DEFAULT_CALENDAR, withLeaveDays } from './business-day';

/**
 * 被判定的那一天。周三，前一个业务日是周二 08-18。
 * 窗口永远是「这两天」——测试里凡是别的日期，都是用来证明它进不来的。
 */
const DAY = '2026-08-19';
const PREV = '2026-08-18';

/**
 * 「这本测试没有法定假期」。
 * ★ 显式写出来，不给默认值 ★ judgeWindow 的 calendar 是必填的——
 * 忘了传是类型错误，不是静默退回「只跳周末」。后者才是国庆当天才会发现的那种 bug。
 */
const NO_HOLIDAY = { calendar: DEFAULT_CALENDAR };

/** 默认造一局达标的探需局。要造反例就覆盖其中一两项 */
function session(overrides: Partial<WindowSession> = {}): WindowSession {
  return {
    sessionId: Math.random().toString(36).slice(2),
    businessDay: DAY,
    type: 'INQUIRY',
    precise: true,
    rawScore: 70,
    insight: 4,
    answerQuality: 2,
    redlines: [],
    ...overrides,
  };
}

/** 按 key 取某一条，不按下标——启用的条目会变，下标会错位 */
function gate(gates: GateView[], key: GateView['key']): GateView {
  const hit = gates.find((g) => g.key === key);
  if (!hit) throw new Error(`没有这一条：${key}`);
  return hit;
}

/** 6 局，前 3 局是判定日当天、后 3 局是前一个业务日——**从新到旧**，和真实取数一致 */
function sixSessions(overrides: Array<Partial<WindowSession>> = []): WindowSession[] {
  return Array.from({ length: 6 }, (_, index) =>
    session({ businessDay: index < 3 ? DAY : PREV, ...(overrides[index] ?? {}) }),
  );
}

describe('判定标准（2026-08-21 起只看局分）', () => {
  it('六局都好 → 达标', () => {
    const verdict = judgeWindow(sixSessions(), DAY, NO_HOLIDAY);
    expect(verdict.passed).toBe(true);
    expect(verdict.medianScore).toBe(70);
    expect(verdict.gates.every((gate) => gate.passed)).toBe(true);
  });

  it('65 正好压线算过；掉到 65 以下要给出「差几分」', () => {
    // 60/60/60/70/70/70 → 中位数正好 65，压线通过
    const edge = judgeWindow(sixSessions([{ rawScore: 60 }, { rawScore: 60 }, { rawScore: 60 }]), DAY, NO_HOLIDAY);
    expect(edge.medianScore).toBe(65);
    expect(edge.passed).toBe(true);

    const worse = judgeWindow(
      sixSessions([{ rawScore: 58 }, { rawScore: 58 }, { rawScore: 58 }, { rawScore: 60 }]),
      DAY, NO_HOLIDAY);
    expect(worse.passed).toBe(false);
    expect(worse.scoreGap).toBeGreaterThan(0);
    expect(gate(worse.gates, 'score').text).toContain('差');
  });

  it('★ 洞察力用中位数不用最低分 ★ 一局 1 分不该全盘否定', () => {
    const verdict = judgeWindow(sixSessions([{ insight: 1 }]), DAY, NO_HOLIDAY);
    expect(verdict.insightMedian).toBe(4);
    expect(verdict.passed).toBe(true);
  });

  // ★ 2026-08-21 起：洞察力/复盘/红线照常算，但不参与「过没过」★
  it('洞察力中位数掉到 2 → 照样达标，但那一条自己是 ✗ 且被记下来', () => {
    const verdict = judgeWindow(
      sixSessions([{ insight: 2 }, { insight: 2 }, { insight: 2 }, { insight: 2 }]),
      DAY, NO_HOLIDAY);
    expect(verdict.passed).toBe(true);
    expect(gate(verdict.allGates, 'insight').passed).toBe(false);
    // 停用的条目不该出现在面板要渲染的那一组里
    expect(verdict.gates.map((g) => g.key)).toEqual(['score']);
  });

  it('复盘作答质量中位数 0 → 照样达标，数据仍然算出来', () => {
    const verdict = judgeWindow(sixSessions(Array.from({ length: 4 }, () => ({ answerQuality: 0 }))), DAY, NO_HOLIDAY);
    expect(verdict.passed).toBe(true);
    expect(verdict.answerMedian).toBe(0);
    expect(gate(verdict.allGates, 'answer').passed).toBe(false);
  });

  it('★ 判定只认局分 ★ 另外三条全烂，只要局分中位数够就达标', () => {
    const verdict = judgeWindow(
      sixSessions(
        Array.from({ length: 6 }, () => ({
          insight: 1,
          answerQuality: 0,
          redlines: [{ code: 'R1', status: 'CONFIRMED' as const }],
        })),
      ),
      DAY, NO_HOLIDAY);
    expect(verdict.passed).toBe(true);
  });

  it('★ 判定只认局分 ★ 另外三条全好，局分差 1 分也不达标', () => {
    const verdict = judgeWindow(sixSessions(Array.from({ length: 6 }, () => ({ rawScore: 64 }))), DAY, NO_HOLIDAY);
    expect(verdict.passed).toBe(false);
    expect(verdict.scoreGap).toBe(1);
  });

  it('本局不评洞察力（null）不参与中位数，也不算缺陷', () => {
    const verdict = judgeWindow(sixSessions([{ type: 'FOLLOWUP', insight: null }]), DAY, NO_HOLIDAY);
    expect(verdict.insightMedian).toBe(4);
    expect(verdict.passed).toBe(true);
  });
});

/* ══════════════════════════════════════════════════════════════
 * 判定窗口是「日」不是「局」（2026-08-21 修回，方案第一节「最近 2 天 6 局」）
 *
 * ★ 这一组是防回归的锁 ★ 原实现是 sessions.slice(0, 6)——「最近 6 局，
 * 不管隔了多久」。于是连着两天缺考的人，窗口里躺的还是上周那 6 局，
 * 照样判达标；教练台上并排出现过「未考 · 局分✓」。
 * 下面每一条都是那个 bug 的一个切面，删任何一条都会让它有机会回来。
 * ══════════════════════════════════════════════════════════════ */
describe('判定窗口按业务日锚定', () => {
  it('窗口天数 × 每天局数 = 窗口局数。三个数必须自洽', () => {
    expect(ADMISSION_CONFIG.windowDays * ADMISSION_CONFIG.sessionsPerExam).toBe(
      ADMISSION_CONFIG.windowSessions,
    );
  });

  it('格子恒为 6 个，从旧到新：先前一个业务日 3 格，再判定日 3 格', () => {
    const slots = buildWindow(sixSessions(), DAY, DEFAULT_CALENDAR);
    expect(slots).toHaveLength(ADMISSION_CONFIG.windowSessions);
    expect(slots.map((slot) => slot.day)).toEqual([PREV, PREV, PREV, DAY, DAY, DAY]);
    expect(slots.map((slot) => slot.sameDay)).toEqual([false, false, false, true, true, true]);
  });

  it('★ 核心 ★ 两天都没考 → 不许拿更早的高分顶上，判不达标', () => {
    // 上周四、周五考得很好，本周三判定时这两天早就出窗口了
    const stale = [
      ...Array.from({ length: 3 }, () => session({ businessDay: '2026-08-14', rawScore: 90 })),
      ...Array.from({ length: 3 }, () => session({ businessDay: '2026-08-13', rawScore: 90 })),
    ];
    const verdict = judgeWindow(stale, DAY, NO_HOLIDAY);
    expect(verdict.passed).toBe(false); // 不是 true——这正是原来那个 bug 的产物；2026-08-22 起缺考判不达标
    expect(verdict.sampleCount).toBe(0);
    expect(verdict.medianScore).toBeNull();
    expect(verdict.slots.every((slot) => slot.session === null)).toBe(true);
  });

  it('★ 核心 ★ 昨天整天缺考、今天考满 3 局 → 判不达标（2026-08-22 起）', () => {
    const todayOnly = Array.from({ length: 3 }, () => session({ businessDay: DAY, rawScore: 80 }));
    const verdict = judgeWindow(todayOnly, DAY, NO_HOLIDAY);
    expect(verdict.passed).toBe(false);
    expect(verdict.sampleCount).toBe(3);
    expect(verdict.missingByDay).toEqual([{ day: PREV, missing: 3 }]);
    // 必须说清缺在哪天，否则人不知道该找谁、也不知道等几天能恢复
    expect(verdict.sampleText).toContain(PREV);
    expect(verdict.sampleText).toContain('整天缺考');
    expect(verdict.sampleText).toContain('补不回来');
  });

  it('缺考一天会连累两天：缺 D 之后，D 和 D 的次日都判不达标', () => {
    // 08-18 缺考，08-17 与 08-19 都考满
    const sessions = [
      ...Array.from({ length: 3 }, () => session({ businessDay: DAY })),
      ...Array.from({ length: 3 }, () => session({ businessDay: '2026-08-17' })),
    ];
    expect(judgeWindow(sessions, PREV, NO_HOLIDAY).passed).toBe(false); // 判 08-18：当天缺考
    expect(judgeWindow(sessions, DAY, NO_HOLIDAY).passed).toBe(false); // 判 08-19：昨天缺考
    // 再往后一天考满，才重新出得了判定
    const recovered = [
      ...Array.from({ length: 3 }, () => session({ businessDay: '2026-08-20' })),
      ...Array.from({ length: 3 }, () => session({ businessDay: DAY })),
    ];
    expect(judgeWindow(recovered, '2026-08-20', NO_HOLIDAY).passed).toBe(true);
  });

  it('一天最多认 3 局，且认**最早**的 3 局——考砸了再开一场挤不掉前面的', () => {
    const sessions = [
      // 从新到旧：后开的两局 99 分在前
      session({ businessDay: DAY, rawScore: 99 }),
      session({ businessDay: DAY, rawScore: 99 }),
      session({ businessDay: DAY, rawScore: 10 }),
      session({ businessDay: DAY, rawScore: 10 }),
      session({ businessDay: DAY, rawScore: 10 }),
      ...Array.from({ length: 3 }, () => session({ businessDay: PREV, rawScore: 70 })),
    ];
    const verdict = judgeWindow(sessions, DAY, NO_HOLIDAY);
    expect(verdict.sampleCount).toBe(ADMISSION_CONFIG.windowSessions);
    // 认最早三局（10/10/10）→ 中位 40；若错认成最新三局（99/99/10）中位会是 70
    expect(verdict.medianScore).toBe(40);
    expect(verdict.passed).toBe(false);
  });

  it('窗口之外的局一律不进来，连红线也不带进来', () => {
    const sessions = [
      ...sixSessions(),
      session({ businessDay: '2026-08-17', redlines: [{ code: 'R1', status: 'CONFIRMED' }] }),
    ];
    const verdict = judgeWindow(sessions, DAY, NO_HOLIDAY);
    expect(verdict.sampleCount).toBe(ADMISSION_CONFIG.windowSessions);
    expect(verdict.effectiveRedlines).toHaveLength(0);
    expect(verdict.passed).toBe(true);
  });

  it('周末打的局进不了任何窗口（业务日只认周一到周五）', () => {
    // 08-15 是周六。判 08-17（周一）时窗口是 08-17 + 08-14（周五），跳过周末
    const slots = buildWindow([session({ businessDay: '2026-08-15' })], '2026-08-17', DEFAULT_CALENDAR);
    expect([...new Set(slots.map((slot) => slot.day))]).toEqual(['2026-08-14', '2026-08-17']);
    expect(slots.every((slot) => slot.session === null)).toBe(true);
  });
});

describe('红线', () => {
  it('R1 仍然被记成生效红线——只是不再判死准入', () => {
    const verdict = judgeWindow(sixSessions([{ redlines: [{ code: 'R1', status: 'CONFIRMED' }] }]), DAY, NO_HOLIDAY);
    expect(verdict.effectiveRedlines).toHaveLength(1);
    expect(gate(verdict.allGates, 'redline').passed).toBe(false);
    expect(verdict.passed).toBe(true);
  });

  /**
   * ★ R4 曾经掉在错误的那一档 ★（2026-08-24 修）
   * `splitRedlines` 原来写死 `code === 'R1'`，而 R4「用中文作答」和 R1 一样是纯代码判的。
   * 于是一条 100% 确定的事实被摆进「等人来判」那一档——而人工裁定已经取消，永远没人来判。
   */
  it('R4 和 R1 一样是代码判的 → 直接记成生效红线，不进待判档', () => {
    const verdict = judgeWindow(sixSessions([{ redlines: [{ code: 'R4', status: 'PENDING' }] }]), DAY, NO_HOLIDAY);
    expect(verdict.effectiveRedlines).toHaveLength(1);
    expect(verdict.pendingRedlines).toHaveLength(0);
    expect(gate(verdict.allGates, 'redline').passed).toBe(false);
    expect(verdict.passed).toBe(true); // 红线闸门没启用，照样达标
  });

  /**
   * ★ 人工裁定已于 2026-08-24 取消 ★ R2/R3 从此停在这一档，不再是中转站。
   * 文案也跟着改了：不能再写「待主管复核」——没有人会来复核，那句话是骗人的。
   */
  it('R2 是模型判的 → 只作反馈，文案不许再承诺有人来复核', () => {
    const verdict = judgeWindow(sixSessions([{ redlines: [{ code: 'R2', status: 'PENDING' }] }]), DAY, NO_HOLIDAY);
    expect(verdict.passed).toBe(true);
    expect(verdict.pendingRedlines).toHaveLength(1);
    expect(verdict.effectiveRedlines).toHaveLength(0);
    const text = gate(verdict.allGates, 'redline').text;
    expect(text).toContain('模型判定');
    expect(text).not.toContain('复核');
  });

  it('取消之前主管判过的误报仍然认账 → 当它不存在', () => {
    const verdict = judgeWindow(sixSessions([{ redlines: [{ code: 'R2', status: 'DISMISSED' }] }]), DAY, NO_HOLIDAY);
    expect(verdict.passed).toBe(true);
    expect(verdict.pendingRedlines).toHaveLength(0);
    expect(verdict.effectiveRedlines).toHaveLength(0);
  });
});

describe('不构成判定', () => {
  it('前一个业务日缺 1 局 → 不达标，并写明缺在哪天缺几局', () => {
    const verdict = judgeWindow(sixSessions().slice(0, 5), DAY, NO_HOLIDAY);
    expect(verdict.passed).toBe(false);
    expect(verdict.enough).toBe(false);
    expect(verdict.sampleCount).toBe(5);
    expect(verdict.missingByDay).toEqual([{ day: PREV, missing: 1 }]);
    expect(verdict.sampleText).toContain(`${PREV} 缺 1 局`);
  });

  it('★ 6 局分数不齐就没资格判达标 ★ 考满 6 局但有 1 局证据不足也不行', () => {
    const verdict = judgeWindow(sixSessions([{ precise: false, rawScore: null }]), DAY, NO_HOLIDAY);
    expect(verdict.sampleCount).toBe(ADMISSION_CONFIG.windowSessions);
    expect(verdict.preciseCount).toBe(5);
    expect(verdict.passed).toBeNull();
    // 这是系统没评出来，不是他的问题——文案必须把责任说清楚
    expect(verdict.sampleText).toContain('证据不足');
    expect(verdict.sampleText).toContain('不是你的问题');
  });

  // ★ 这一组锁的是措辞，不是判定 ★ 同一句话同时出现在教练台「差在哪」
  // 和业务员自己的首页状态条上，两处飘了就是两套说法。
  it('★ 今天还没过完 ★ 今天的空格不许说成「整天缺考」', () => {
    const yesterdayOnly = Array.from({ length: 3 }, () => session({ businessDay: PREV }));
    const live = judgeWindow(yesterdayOnly, DAY, { ...NO_HOLIDAY, dayInProgress: true });
    expect(live.passed).toBeNull();
    expect(live.sampleText).toContain('今天还没考完');
    expect(live.sampleText).not.toContain(`${DAY} 整天缺考`);
    // 同样一组局，当晚结算（这天已经过完）就该记成缺考
    const settled = judgeWindow(yesterdayOnly, DAY, NO_HOLIDAY);
    expect(settled.sampleText).toContain(`${DAY} 整天缺考`);
  });

  it('昨天真缺考 + 今天还没考完 → 只记昨天，并说明今天那几局不算缺考', () => {
    const verdict = judgeWindow([], DAY, { ...NO_HOLIDAY, dayInProgress: true });
    expect(verdict.sampleText).toContain(`${PREV} 整天缺考`);
    expect(verdict.sampleText).not.toContain(`${DAY} 整天缺考`);
    expect(verdict.sampleText).toContain('不算缺考');
  });

  it('措辞变了但判定没变：还没考完一样是「不构成判定」', () => {
    const sessions = Array.from({ length: 3 }, () => session({ businessDay: PREV }));
    expect(judgeWindow(sessions, DAY, { ...NO_HOLIDAY, dayInProgress: true }).passed).toBeNull();
    expect(judgeWindow(sessions, DAY, { ...NO_HOLIDAY, dayInProgress: true }).missingByDay).toEqual([
      { day: DAY, missing: 3 },
    ]);
  });

  it('缺考和证据不足说的不是同一句话', () => {
    const absent = judgeWindow(sixSessions().slice(0, 5), DAY, NO_HOLIDAY).sampleText;
    const imprecise = judgeWindow(sixSessions([{ precise: false, rawScore: null }]), DAY, NO_HOLIDAY).sampleText;
    expect(absent).not.toBe(imprecise);
    expect(absent).not.toContain('不是你的问题');
  });
});

describe('状态条文案', () => {
  it('未达标要给距离，不只给结论', () => {
    const verdict = judgeWindow(sixSessions(Array.from({ length: 4 }, () => ({ rawScore: 61 }))), DAY, NO_HOLIDAY);
    const line = statusLine(verdict);
    expect(line).toContain('距 65 差');
    expect(line).not.toContain('未达标');
  });

  it('达标时给结论，且不再列停用的那几条', () => {
    const line = statusLine(judgeWindow(sixSessions(), DAY, NO_HOLIDAY));
    expect(line).toContain('达标 ✓');
    // 洞察/红线/复盘现在不决定任何事，摆在这儿是误导
    expect(line).not.toContain('洞察');
    expect(line).not.toContain('红线');
    expect(line).not.toContain('复盘');
  });
});

/* ══════════════════════════════════════════════════════════════
 * 当日考试状态：数局，不读 ExamAttempt.verdict（2026-08-21 修）
 *
 * ★ 这一组锁的是「两列证据同源」★ 原来判定读局、当日基本任务读 attempt 的
 * 结算标志。三局都考完出了分、只是自动交卷失败的人，会同时看到
 * 「中位 62.5 · 局分✗」（判定已经用了这三局）和「✗ 考试没打完」——同一行自打脸。
 * ══════════════════════════════════════════════════════════════ */
/* ══════════════════════════════════════════════════════════════
 * 工作日历：法定假期与个人请假（2026-08-21 王老师定）
 *
 * ★ 这一组锁的是「假期不该被当成缺考」★ 在此之前业务日只跳周六周日，
 * 国庆七天在代码眼里全是工作日 —— 假期里每人每天判「整天缺考」，
 * 假期后还要再连累两天判不出结论。春节更长。
 * ══════════════════════════════════════════════════════════════ */
describe('工作日历', () => {
  // 2026-10-01(四) ~ 10-07(三) 国庆；09-30 是周三，10-08 是周四
  const NATIONAL_DAY = calendarFrom(
    new Map([
      ['2026-10-01', false], ['2026-10-02', false], ['2026-10-05', false],
      ['2026-10-06', false], ['2026-10-07', false],
      // 10-03/04 本来就是周末，不必标
    ]),
  );

  it('★ 核心 ★ 假期后第一天的「前一个业务日」是节前那天，不是假期里的某天', () => {
    const slots = buildWindow([], '2026-10-08', NATIONAL_DAY);
    expect([...new Set(slots.map((slot) => slot.day))]).toEqual(['2026-09-30', '2026-10-08']);
  });

  it('不带日历时会踩到老毛病：把 10-07 当成工作日', () => {
    // 这条不是「期望的行为」，是把默认日历的局限钉在这里——
    // 生产代码里出现 DEFAULT_CALENDAR 就意味着有人忘了把公司日历传下来
    const slots = buildWindow([], '2026-10-08', DEFAULT_CALENDAR);
    expect([...new Set(slots.map((slot) => slot.day))]).toEqual(['2026-10-07', '2026-10-08']);
  });

  it('假期里打的局进不了任何窗口（照评不判）', () => {
    const inHoliday = Array.from({ length: 3 }, () =>
      session({ businessDay: '2026-10-05', rawScore: 90 }),
    );
    const verdict = judgeWindow(inHoliday, '2026-10-08', { calendar: NATIONAL_DAY });
    expect(verdict.sampleCount).toBe(0);
    // 假期里打的局不进窗口，于是这两个工作日都是空的 → 缺考 → 不达标
    expect(verdict.passed).toBe(false);
  });

  it('★ 调休 ★ 被标成上班的周六要进窗口', () => {
    // 2026-10-10 是周六，标成调休上班；10-11 周日仍休息；10-12 周一
    const makeup = calendarFrom(new Map([['2026-10-10', true]]));
    const slots = buildWindow([], '2026-10-12', makeup);
    expect([...new Set(slots.map((slot) => slot.day))]).toEqual(['2026-10-10', '2026-10-12']);
  });

  it('★ 陷阱回归 ★ 个人请假不许把「调休上班」一起取消掉', () => {
    const makeup = calendarFrom(new Map([['2026-10-10', true]]));
    // 他请的是 10-12 的假，不该影响 10-10 那个调休工作日
    const mine = withLeaveDays(makeup, new Set(['2026-10-12']));
    expect(mine.isWorkday('2026-10-10')).toBe(true);
    expect(mine.isWorkday('2026-10-12')).toBe(false);
  });

  it('请假的日子从他自己的窗口里跳过，不留空格', () => {
    // 他 08-18 请假，08-17 和 08-19 都考满 3 局
    const sessions = [
      ...Array.from({ length: 3 }, () => session({ businessDay: DAY })),
      ...Array.from({ length: 3 }, () => session({ businessDay: '2026-08-17' })),
    ];
    // 不请假：08-18 整天缺考 → 不达标
    expect(judgeWindow(sessions, DAY, NO_HOLIDAY).passed).toBe(false);
    // 请假之后：窗口变成 08-17 + 08-19，考满 6 局，判得出来
    const onLeave = { calendar: withLeaveDays(DEFAULT_CALENDAR, new Set([PREV])) };
    const verdict = judgeWindow(sessions, DAY, onLeave);
    expect(verdict.sampleCount).toBe(ADMISSION_CONFIG.windowSessions);
    expect(verdict.passed).toBe(true);
    expect(verdict.missingByDay).toEqual([]);
  });

  it('日历填错（连续一年不上班）要抛错，不能死循环', () => {
    const broken = { isWorkday: () => false };
    expect(() => buildWindow([], DAY, broken)).toThrow(/工作日历填错/);
  });
});

describe('当日考试状态', () => {
  it('★ 核心 ★ 三局都出分 → 已考，跟交没交卷无关', () => {
    // started=true 表示开过考；自动交卷失败与否都不该改变这个结论
    expect(examStateOf(ADMISSION_CONFIG.sessionsPerExam, true)).toBe('已考');
    expect(examStateOf(ADMISSION_CONFIG.sessionsPerExam, false)).toBe('已考');
  });

  it('考到一半 → 进行中，不是「已考」也不是「未考」', () => {
    expect(examStateOf(1, true)).toBe('进行中');
    expect(examStateOf(ADMISSION_CONFIG.sessionsPerExam - 1, true)).toBe('进行中');
  });

  it('开了考但一局没打完 → 进行中（开考瞬间 3 局就生成好了，但都还没出分）', () => {
    expect(examStateOf(0, true)).toBe('进行中');
  });

  it('没开考 → 未考', () => {
    expect(examStateOf(0, false)).toBe('未考');
  });

  it('同一天多打了几局（补考、重开）→ 仍是已考，不会越界', () => {
    expect(examStateOf(ADMISSION_CONFIG.sessionsPerExam + 2, true)).toBe('已考');
  });
});

describe('训练期解锁闸门', () => {
  it('练够 3 局才解锁，文案要写明不看分数', () => {
    expect(unlockState(2, 'TRAINING').unlocked).toBe(false);
    // 未解锁时只说下一步动作：还差几局
    expect(unlockState(2, 'TRAINING').text).toContain('再练 1 局');
    // ★ 不许再出现「练得好不好都行」这类话 ★（2026-08-23 王老师定）
    expect(unlockState(2, 'TRAINING').text).not.toContain('不影响解锁');
    expect(unlockState(3, 'TRAINING').unlocked).toBe(true);
  });

  it('在岗期不要求演习局', () => {
    expect(unlockState(0, 'ACTIVE').unlocked).toBe(true);
  });

  /**
   * ★ 锁「一局怎么才算数」这句话 ★（2026-08-22）
   * 闸门口径改成「聊满 N 轮 + 做完复盘出了报告」之后，最容易出的事不是算错，
   * 是**没告诉人**：他明明练了三局，进度却停在 2/3，而界面只说「再练 1 局」。
   * 那会让人反复去开新局，而真正要做的是把上一局的复盘答完。
   */
  // ★ 2026-08-23 王老师定：这句话只说下一步动作 ★
  // 原来它要求文案写明「一局」的两个条件（聊满 6 轮、做完复盘）。那是规则，
  // 现在规则统一收在考前必读里，界面上这一行只回答「我现在该干什么」。
  it('未解锁的文案只说下一步动作，不夹带规则解释', () => {
    const text = unlockState(1, 'TRAINING').text;
    expect(text).toContain('再练 2 局');
    expect(text).not.toContain('聊满');
    expect(text).not.toContain('复盘');
  });

  /**
   * ★ 第二道条件：不能三局全挑简单 ★（2026-08-23，随简单档 3→18 封一起加）
   * 加这条之前，配置里写着「简单局也算，反正全系统只有 3 封简单探需，刷不动」。
   * 简单档扩到 18 封之后那句话不再成立，于是补了
   * `minNonSimpleDrillsForUnlock`：局数照算，但至少 1 局得是标准或困难。
   */
  describe('三局不能全是简单局', () => {
    const min = ADMISSION_CONFIG.minNonSimpleDrillsForUnlock;

    it('★ 局数够了、但全是简单局 → 不解锁 ★', () => {
      const state = unlockState(ADMISSION_CONFIG.dailyDrillMin, 'TRAINING', 0);
      expect(state.unlocked).toBe(false);
    });

    it('局数够 + 至少 1 局标准或困难 → 解锁', () => {
      expect(unlockState(ADMISSION_CONFIG.dailyDrillMin, 'TRAINING', min).unlocked).toBe(true);
    });

    /**
     * ★ 这条是给界面兜底的 ★ 3/3 却不给考，是最招人骂的一种拦法：
     * 数字已经满了，人不可能猜到差的是难度。文案必须自己说出来。
     */
    it('局数满了却被拦时，文案要说难度，不能再说「再练 N 局」', () => {
      const text = unlockState(ADMISSION_CONFIG.dailyDrillMin, 'TRAINING', 0).text;
      expect(text).toContain('标准或困难');
      expect(text).not.toContain('再练');
    });

    it('局数不够且一局非简单都没有 → 两件事一起说', () => {
      const text = unlockState(0, 'TRAINING', 0).text;
      expect(text).toContain(`再练 ${ADMISSION_CONFIG.dailyDrillMin} 局`);
      expect(text).toContain('标准或困难');
    });

    it('不传第三个参数 → 当作全都不是简单局（老调用点不被误拦）', () => {
      expect(unlockState(ADMISSION_CONFIG.dailyDrillMin, 'TRAINING').unlocked).toBe(true);
    });

    it('在岗期不受这条约束', () => {
      expect(unlockState(0, 'ACTIVE', 0).unlocked).toBe(true);
    });

    it('★ 闸门给的理由要写清是难度不够，不是局数不够 ★', () => {
      const gate = examGateOf({
        track: 'ADMISSION',
        stage: 'TRAINING',
        drillsToday: ADMISSION_CONFIG.dailyDrillMin,
        nonSimpleDrillsToday: 0,
        todayAttempt: 'none',
      });
      expect(gate.canStart).toBe(false);
      expect(gate.reason).toContain('标准或困难');
    });

    it('闸门：局数够且难度够 → 放行', () => {
      expect(
        examGateOf({
          track: 'ADMISSION',
          stage: 'TRAINING',
          drillsToday: ADMISSION_CONFIG.dailyDrillMin,
          nonSimpleDrillsToday: min,
          todayAttempt: 'none',
        }).canStart,
      ).toBe(true);
    });
  });
});

describe('人工设定只管当天', () => {
  const setOn = (day: string) => ({ stageOverride: true, setOnDay: day });

  it('主管 08-19 设的，结算 08-19（次日凌晨跑）时就到期，系统当场接管', () => {
    expect(overrideStillActive({ ...setOn('2026-08-19'), settlingDay: '2026-08-19' })).toBe(false);
  });

  it('补算更早的日子时仍然作数——不能拿前天的成绩推翻今天的人工决定', () => {
    expect(overrideStillActive({ ...setOn('2026-08-19'), settlingDay: '2026-08-18' })).toBe(true);
    expect(overrideStillActive({ ...setOn('2026-08-19'), settlingDay: '2026-08-12' })).toBe(true);
  });

  it('设定日之后的日子一律不作数', () => {
    expect(overrideStillActive({ ...setOn('2026-08-19'), settlingDay: '2026-08-20' })).toBe(false);
  });

  it('没被人工设定过 → 永远不锁', () => {
    expect(overrideStillActive({ stageOverride: false, setOnDay: '2026-08-19', settlingDay: '2026-08-18' })).toBe(false);
  });

  it('★ 老数据兜底 ★ 标着人工设定却没有设定日 → 当作已到期，不再永久锁人', () => {
    expect(overrideStillActive({ stageOverride: true, setOnDay: null, settlingDay: '2026-08-19' })).toBe(false);
  });
});

describe('缺考算不达标（2026-08-22 王老师定）', () => {
  const full = (day: string, score: number): WindowSession[] =>
    [1, 2, 3].map((n) => session({ businessDay: day, rawScore: score, sessionId: `${day}-${n}` }));

  it('两天都考满、分够 → 达标', () => {
    const v = judgeWindow([...full(DAY, 70), ...full(PREV, 70)], DAY, { calendar: DEFAULT_CALENDAR });
    expect(v.passed).toBe(true);
  });

  it('★ 昨天整天缺考 → 不达标（不是「不构成判定」）★ 这是缺考不再能保资格的那一条', () => {
    const v = judgeWindow(full(DAY, 90), DAY, { calendar: DEFAULT_CALENDAR });
    expect(v.passed).toBe(false);
    expect(v.sampleText).toContain('缺考算不达标');
  });

  it('缺一局也算不达标——分再高也不行', () => {
    const v = judgeWindow([...full(DAY, 95), ...full(PREV, 95).slice(0, 2)], DAY, { calendar: DEFAULT_CALENDAR });
    expect(v.passed).toBe(false);
  });

  it('一局都没考 → 不达标', () => {
    expect(judgeWindow([], DAY, { calendar: DEFAULT_CALENDAR }).passed).toBe(false);
  });

  it('★ 今天还没考完不算缺考 ★ 界面上「今天」那一行传 dayInProgress，仍是「不构成判定」', () => {
    const v = judgeWindow(full(PREV, 70), DAY, { calendar: DEFAULT_CALENDAR, dayInProgress: true });
    expect(v.passed).toBe(null);
  });

  it('★ 考了但系统没评出分 → 仍然不构成判定 ★ 那不是他的错，不记不达标', () => {
    const noScore = (day: string) =>
      [1, 2, 3].map((n) => session({ businessDay: day, precise: false, rawScore: null, sessionId: `${day}-x${n}` }));
    const v = judgeWindow([...full(DAY, 70), ...noScore(PREV)], DAY, { calendar: DEFAULT_CALENDAR });
    expect(v.passed).toBe(null);
  });
});

describe('一天一场：考完就锁（2026-08-22 王老师定）', () => {
  const base = { track: 'ADMISSION' as const, stage: 'ACTIVE' as const, drillsToday: 0 };

  it('在岗期、今天还没考 → 能考', () => {
    expect(examGateOf({ ...base, todayAttempt: 'none' }).canStart).toBe(true);
  });

  it('★ 今天这场考完了 → 锁住，按钮上写明每天 1 场 ★', () => {
    const gate = examGateOf({ ...base, todayAttempt: 'done' });
    expect(gate.canStart).toBe(false);
    expect(gate.reason).toContain('每人每天 1 场');
  });

  it('今天这场还没打完 → 也不给开第二场', () => {
    expect(examGateOf({ ...base, todayAttempt: 'running' }).canStart).toBe(false);
  });

  it('训练期没练够演习 → 锁住，且写清还差几局（不是「考完了」）', () => {
    const gate = examGateOf({ track: 'ADMISSION', stage: 'TRAINING', drillsToday: 1, todayAttempt: 'none' });
    expect(gate.canStart).toBe(false);
    expect(gate.reason).toContain(`1/${ADMISSION_CONFIG.dailyDrillMin}`);
  });

  it('训练期练够了、今天还没考 → 能考', () => {
    expect(
      examGateOf({
        track: 'ADMISSION',
        stage: 'TRAINING',
        drillsToday: ADMISSION_CONFIG.dailyDrillMin,
        todayAttempt: 'none',
      }).canStart,
    ).toBe(true);
  });

  it('不参加考试的账号（主管、身份待确认）→ 一律不给考', () => {
    expect(examGateOf({ ...base, track: null, todayAttempt: 'none' }).canStart).toBe(false);
  });
});

/**
 * ★ 2026-08-24 王老师定：正式业务员也能练、也能考 ★
 * 「正式业务员每周至少考两场，也就是每周至少有 6 局的考试分数出来。」
 *
 * 周考轨与准入轨在这道闸上只差一条：**不查「当日先练 3 局」**。
 * 一天一场那条对两条轨都成立——王老师的顾虑（一天考多次就会一直刷分、
 * 没时间维护现有客户）对正式业务员一样适用。
 */
describe('周考轨的开考闸（2026-08-24 王老师定）', () => {
  const weekly = { track: 'WEEKLY' as const, stage: 'TRAINING' as const, todayAttempt: 'none' as const };

  it('★ 一局演习都没练也能考 ★ 那道闸是训练期实习生的，不套在正式业务员头上', () => {
    const gate = examGateOf({ ...weekly, drillsToday: 0, nonSimpleDrillsToday: 0 });
    expect(gate.canStart).toBe(true);
    expect(gate.reason).toBe('');
  });

  it('期别对周考轨不起作用——他根本没有期别', () => {
    expect(examGateOf({ ...weekly, stage: 'ACTIVE', drillsToday: 0 }).canStart).toBe(true);
  });

  it('★ 一天一场对周考轨同样成立 ★ 考完当天不能再考', () => {
    const gate = examGateOf({ ...weekly, todayAttempt: 'done', drillsToday: 0 });
    expect(gate.canStart).toBe(false);
    expect(gate.reason).toContain('每人每天 1 场');
  });

  it('今天这场还没打完 → 不给开第二场', () => {
    expect(examGateOf({ ...weekly, todayAttempt: 'running', drillsToday: 0 }).canStart).toBe(false);
  });

  it('拒绝的理由不许再写「不参加实习业务员准入」——正式业务员是要考的', () => {
    const gate = examGateOf({ ...weekly, track: null, drillsToday: 0 });
    expect(gate.reason).not.toContain('准入');
  });
});

describe('activeGates 不许是空数组（2026-08-22 加）', () => {
  /**
   * ★ 这条锁的是一个「看起来很合理、后果很难看」的操作 ★
   * 有人想临时关掉判定，最顺手的动作就是把 activeGates 清空。
   * 而 passed 那一步是 `gates.every(g => g.passed)`——**every 对空数组恒真**，
   * 于是结果不是「谁都判不了」，是**六局全 0 分也判达标、全员当场拿到分配权**，
   * 界面上还一片绿。等发现时询盘已经分出去了。
   */
  type Mutable = { activeGates: GateView['key'][] };

  it('★ 清空 activeGates → judgeWindow 当场抛错，而不是全员达标 ★', () => {
    const original = [...ADMISSION_CONFIG.activeGates];
    // `as const` 只是类型上的只读，值本身是普通数组——改完必须还原，
    // 否则同一个进程里后面那些测试会读到被改坏的配置。
    const config = ADMISSION_CONFIG as unknown as Mutable;
    config.activeGates = [];
    try {
      // 六局全是 70 分，正常情况下这是一组稳稳达标的样本
      expect(() => judgeWindow(sixSessions(), DAY, NO_HOLIDAY)).toThrow(/activeGates/);
    } finally {
      config.activeGates = original;
    }
  });

  it('还原之后照常判定 —— 证明上一条没把配置改坏', () => {
    expect(judgeWindow(sixSessions(), DAY, NO_HOLIDAY).passed).toBe(true);
  });

  it('默认配置至少启用一条 —— 防止「清空了还提交」', () => {
    expect(ADMISSION_CONFIG.activeGates.length).toBeGreaterThan(0);
  });
});
