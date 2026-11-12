/**
 * 准入判定 v1.1（《实习期业务员训练与询盘准入方案 v1.1》第一节）
 *
 * ★ 判定单位是「最近 2 个业务日、每天 3 局、共 6 局」，不是「今天这一场」★
 * 这是 v1.1 相对 v2.0/v3.0 最要紧的一处改动。判定不再挂在某一场考试上，
 * 而是挂在「判定日 + 前一个业务日」这两天的考试局上——所以本文件只认一串局，
 * 不认 attemptId。附带的好处是：谁也没法靠「不点结算」把判定冻住，
 * 因为判定根本不读考试的结算状态，只读局和分。
 *
 * ★ 2026-08-21 修回：窗口是「日」不是「局」★
 * 原实现取的是 `sessions.slice(0, 6)`——这个人最近的 6 局，**不管隔了多久**。
 * 后果：连着两天缺考的人，窗口里躺的还是上周那 6 局，照样判「达标 ✓」。
 * 教练台上就并排出现过「未考 · 局分✓」——那不是显示 bug，
 * 是判定真的把旧分当成了今天的成绩。方案第一节从头到尾写的都是「最近 2 天 6 局」，
 * 是实现跑偏了。现在按日排 6 个格子，当天没考的格子就是空的，空格不许拿旧分去填。
 *
 * ★ 2026-08-21 王老师裁定：判定只看局分一条 ★
 *   最近 6 局**局分中位数 ≥ 65（D4）**，门槛不变。
 *
 * 原来是四条全过（局分／洞察力中位数 ≥3／最近 2 天无生效红线／复盘中位数 ≥1）。
 * 砍掉另外三条的理由与代价，当时都摆过：
 *   · 洞察力本来就在局分里（七力里权重最高，探需局 0.30）。那一条是给它加地板，
 *     防止用其他六力把它的低分平均掉。砍掉之后局分不变，只是没有地板了。
 *   · 复盘作答质量**完全不进局分**——这是四条里唯一另一把尺，砍掉＝复盘答得再烂也不影响准入。
 *   · 红线不进局分公式，但扣信任/耐心/兴趣会让客户提前离场，仍会间接压分；
 *     R2/R3 靠模型判，原本靠主管人工裁定对冲误判——**该裁定已于 2026-08-24 整个取消**
 *     （王老师：红线起间接作用就够了）。红线现在只进报告与客户情绪值，不判任何人的生死。
 *   · ★ 四条变一条，实际通过难度会下降 ★ 65 这条线原本是配着另外三条一起定的，
 *     裁定保持 65 不动——这一条记在这儿，将来发现放水了，是回来调 medianScoreMin，
 *     不是再把三条塞回去。
 *
 * ★ 洞察力/复盘/红线照常算、照常存 ★ 只是不再参与「过没过」。
 * DailyEvaluation 那几列继续写，将来要回滚或者要做统计，数据是全的。
 *
 * ★ 演习局永不进入这个窗口 ★ 方案第七节：「演习计入准入：不计入（保持）」。
 * 训练期要求的「当日 ≥3 局演习」是**行为量**闸门，只看练了几局，不看打多少分。
 *
 * ★ 本文件是纯函数 ★ 不碰数据库、不读时钟。喂什么判什么，好测。
 */

import { median } from './exam';
import { isHardRedline } from '../../engine/rules';
import { recentBusinessDays, type WorkCalendar } from './business-day';
import type { ExamTrack } from './exam-track';

/**
 * ★ 阈值全部集中在这里 ★（方案第六节 P1：「阈值配置化，改一行不动逻辑」）
 * 改数字只改这一处；任何地方再出现 65 / 3 / 1 的字面量都是复制，属于 bug。
 */
export const ADMISSION_CONFIG = {
  /**
   * 判定窗口跨几个**业务日**（方案第一节「最近 2 天 6 局」）。
   * ★ 窗口的锚是日期，不是局数 ★ 判定 D 这天，看的永远是 D 和 D 的前一个业务日，
   * 中间缺的局就是缺着——不会自动往前多捞几局把窗口填满。
   */
  windowDays: 2,
  /** 判定窗口共几局 = windowDays × sessionsPerExam。三个数要一起改，有测试锁着 */
  windowSessions: 6,
  /** 红线只看最近这么多天（方案：最近 2 天内有无生效红线） */
  redlineWindowDays: 2,
  /** 局分中位数门槛。65 = D4「进阶期」下沿 */
  medianScoreMin: 65,
  /**
   * 判定启用哪几条（2026-08-21 王老师裁定：只留局分）。
   *
   * ★ 改这一个数组就能加回来 ★ 四条的算法一条都没删，
   * 想恢复成四条全过，写回 `['score', 'insight', 'redline', 'answer']` 即可，
   * 界面上的列会跟着自动变成几条显示几条。
   */
  activeGates: ['score'] as readonly GateKey[],
  /** 洞察力中位数门槛。★ 中位数，不是最低分 ★ */
  insightMedianMin: 3,
  /** 复盘作答质量中位数门槛 */
  answerQualityMedianMin: 1,
  /**
   * 窗口里至少要有几局拿到精确局分。
   *
   * ★ 2026-08-21 王老师裁定：6 局分数不齐，就没资格判达标 ★
   * 原来是 4（容许 2 局证据不足）。现在窗口按日排死了 6 格，
   * 「格子里有局」和「那一局有分」是两件事，两件都要齐：
   *   · 格子空着 = 缺考，是他没考；
   *   · 格子有局但没分 = 证据不足，是系统没评出来。
   * ★ 2026-08-22 起两者分道扬镳 ★
   *   · 格子空着（缺考）→ **判不达标**，连续天数照加
   *   · 格子有局但没分（证据不足）→ 仍然「不构成判定」，不算他的
   * ★ 代价 ★ 证据不足不是业务员的错，却也会挡住他当天拿达标。
   * 要放宽就把这个数调回 4，判定逻辑一行不用动。
   */
  preciseMin: 6,
  /** 训练期开考前置：当日演习局数 */
  dailyDrillMin: 3,
  /**
   * 一局演习要业务员自己说满几轮才算「有效局」。
   *
   * ★ 搬到这里来是因为文案要用它 ★（2026-08-22）这个数原来只长在
   * `settlement.ts` 的 `VALID_DRILL_MIN_TURNS`，而那个文件 import prisma——
   * 解锁卡的文案在纯模块里生成，够不着它，于是界面上只能写死一个 6，
   * 或者干脆不写（那就是现在这样：被拦住的人不知道自己差在哪）。
   * 阈值真源只有这一处，`settlement.ts` 现在从这里读。
   *
   * ★ 「有效局」不止这一条 ★ 还要求**出了报告**（＝复盘做完了）。
   * 那一条不是数字，没法放进配置，口径在 `settlement.countDrillsToday`。
   */
  validDrillMinTurns: 6,
  /**
   * 解锁的那 3 局里，至少几局**不是**简单局。
   *
   * ★ 2026-08-23 换掉了原来的 simpleDrillCountsForUnlock ★
   * 原配置是个布尔，取 true，理由白纸黑字写着：「门槛定位是行为量不是水平，
   * 且**全系统只有 3 封简单探需，刷不动**」。那句话在当天失效了——
   * 简单档从 3 封扩到 18 封（P1／P13／P17 各补 5 个化身），
   * 「刷不动」的前提没了：新人可以每天挑三局最容易的简单局把考试解锁出来。
   *
   * ★ 为什么不是干脆把简单局排除在外 ★ 原布尔的 false 分支实现的是
   * 「简单局一局都不算」，比这里严。那样扩出来的 18 封简单局对解锁毫无价值，
   * 新人练它等于白练——而简单档存在的意义正是让人多练。
   * 取「3 局里至少 1 局标准或困难」：简单局照算进分子，但不能三局全是简单。
   *
   * 调 0 ＝ 回到旧的「简单局也算」；调到 dailyDrillMin ＝ 简单局完全不算。
   */
  minNonSimpleDrillsForUnlock: 1,
  /** 连续几天不达标才暂停分配新询盘 */
  consecutiveFailsToSuspend: 2,
  /** 一场考试几局 */
  sessionsPerExam: 3,
} as const;

/**
 * 每晚结算跑在几点（上海时间）。**只用于界面文案**，不参与任何调度。
 *
 * ★ 真正的调度在 vercel.json 的 crons ★ 那里写的是 `5 16 * * *`——**UTC**，
 * 换算过来正是上海 00:05。两处必须一起改，所以在这儿留一句对账话：
 *   界面说几点 = 这个常量；系统几点跑 = vercel.json。改了一处没改另一处，
 *   页面上就会写着一个时间、实际跑在另一个时间，而没有任何东西会报错。
 *   （vercel.json 是 JSON，写不了注释，所以对账话只能留在这儿。）
 *
 * ★ 2026-08-28：01:00 → 00:05 ★（王老师定）
 * 业务日 00:00 就翻页了，而结算原来 01:00 才跑，中间空着整整一小时——
 * 在那一小时里，昨天没考完的场次已经算「跨天」，却还没被作废。
 * 现在贴着业务日的边跑，那道缝收到 5 分钟。
 * 【留 5 分钟不留 0 分钟】cron 本来就不保证准点，业务日又是按上海时区算的；
 * 掐在 00:00 触发，只要调度晚一点点或者机器时钟差一点点，
 * 就可能在**上一个业务日**跑起来——那会把「只结算已经过去的业务日」整条判反。
 *
 * ★ 为什么值得抽出来 ★ 原来「凌晨 1 点」是硬写在账号管理页那段说明里的，
 * 而同一页别处的阈值都从 ADMISSION_CONFIG 取——一页里两套写法，
 * 改配置时改了跟着变的那些，写死的这些就悄悄变成假话。
 */
export const SETTLE_LOCAL_TIME = '凌晨 00:05';

/**
 * 期别。v1.1 只有两期：训练期（没有分配权）、在岗期（有）。
 *
 * ★ 定义放在这个纯模块里 ★ 原来长在 settlement.ts（它 import prisma），
 * 中文名长在 board.ts（同样 import prisma）。教练台的历史台账要做成可筛选的，
 * 那是个客户端组件——它一 import board.ts 就会把 prisma 拖进浏览器包里。
 * 期别本来就是方案口径，跟阈值放一起才对。
 */
export type Stage = 'TRAINING' | 'ACTIVE';
export const STAGE_LABEL: Record<Stage, string> = { TRAINING: '训练期', ACTIVE: '在岗期' };

export type GateKey = 'score' | 'insight' | 'redline' | 'answer';

export type RedlineStatus = 'PENDING' | 'CONFIRMED' | 'DISMISSED';

export interface WindowSession {
  sessionId: string;
  /** 这一局所属的上海业务日 */
  businessDay: string;
  type: 'INQUIRY' | 'FOLLOWUP';
  precise: boolean;
  rawScore: number | null;
  /** 本局不评洞察力（人设的 na_forces）或证据不足时为 null，不参与中位数 */
  insight: number | null;
  answerQuality: number | null;
  redlines: Array<{ code: string; status: RedlineStatus }>;
}

export interface GateView {
  key: GateKey;
  label: string;
  passed: boolean;
  /** 面板上那一行人话。未达标时**必须带距离**，不能只说「未达标」 */
  text: string;
}

/**
 * 判定窗口里的一格。
 *
 * ★ 为什么要有「空格」这个概念 ★ 只传一串局进来的话，
 * 「昨天考了 3 局」和「昨天一局没考、拿前天的顶上」在数据上长得一模一样。
 * 排成固定 6 格、当天没考就空着，缺考才藏不住。
 */
export interface WindowSlot {
  /** 这一格属于哪个业务日 */
  day: string;
  /** 是不是被判定的那一天考的。界面靠它区分「今天考的」和「昨天带过来的」 */
  sameDay: boolean;
  /** 当天的第几局，从 1 起 */
  nth: number;
  /** null = 这一格没有局，就是缺考 */
  session: WindowSession | null;
}

export interface WindowVerdict {
  sampleCount: number;
  preciseCount: number;
  /** 样本够不够构成判定 */
  enough: boolean;
  medianScore: number | null;
  insightMedian: number | null;
  answerMedian: number | null;
  /** null = 不构成判定（今天还没考完 / 考了但没评出分）。**缺考不在此列，缺考判 false** */
  passed: boolean | null;
  /** ★ 只含启用的那几条 ★ 停用的条目算了但不摆出来，见 ADMISSION_CONFIG.activeGates */
  gates: GateView[];
  /** 四条全都算了一遍的原始结果。停用的那几条也在里面，供留档与统计 */
  allGates: GateView[];
  /** 生效红线。人工裁定 2026-08-24 取消后，实际只可能是 R1／R4 这两条代码判的 */
  effectiveRedlines: string[];
  /**
   * 模型判出来、未经人工确认的红线（R2/R3）。**不否决任何人**，但要显眼——
   * 它是给业务员看的反馈，也是回头查「模型判得准不准」的线索。
   * ★ 人工裁定已取消 ★ 所以这一档是 R2/R3 的终点，不是中转站。
   */
  pendingRedlines: string[];
  /** 还差几分。已达标为 0 */
  scoreGap: number;
  /** 样本不足时的那句话：缺在哪天、还差几局 */
  sampleText: string;
  /** 6 个格子，**从旧到新**。空格 = 缺考 */
  slots: WindowSlot[];
  /** 缺考明细：哪天缺几局。空数组 = 两天都考满了 */
  missingByDay: Array<{ day: string; missing: number }>;
}

/**
 * 把一串考试局排进「判定日 + 前一个业务日」那 6 个格子里。
 *
 * @param sessionsNewestFirst 这个人的考试局，**从新到旧**。演习局不要传进来。
 * @param asOfDay 被判定的业务日。窗口 = 这一天 + 它的前一个业务日。
 * @returns 恰好 windowSessions 格，**从旧到新**——走势是往右走的，倒着摆没人看得懂。
 *
 * ★ 一天最多认 3 局，取当天最早的 3 局 ★ 正常情况一天就是 1 场 3 局。
 * 万一同一天多出局来（补考、重开），认最早那 3 局：不然一个人考砸了再开一场，
 * 就能拿后开的把前面的挤出窗口——那等于允许刷分。
 *
 * ★ 周末与假期的局进不来 ★ 窗口只由 calendar 说了算上班的日子组成。
 * 周末、法定假期、个人请假当天打的考试局有 businessDay，但任何一天的窗口都不含它们——
 * **照常评分、照常写进报告，只是不参与准入判定**（与红线现在的处理一致）。
 * 这一条要写进考试页文案，否则加练的人白打了还不知道。
 */
export function buildWindow(
  sessionsNewestFirst: WindowSession[],
  asOfDay: string,
  /**
   * 工作日历。★ 必填，没有默认值 ★
   * 传 DEFAULT_CALENDAR 就是「只跳周末、不认法定假期」——那正是国庆期间
   * 把全员判成缺考的老毛病。强制显式传入，是为了让每个调用点都必须回答
   * 「你用的是哪本日历」，而不是悄悄退回默认。
   */
  calendar: WorkCalendar,
): WindowSlot[] {
  const perDay = ADMISSION_CONFIG.sessionsPerExam;
  // recentBusinessDays 返回从新到旧，含 asOfDay 本身
  const days = recentBusinessDays(ADMISSION_CONFIG.windowDays, asOfDay, calendar);
  const slots: WindowSlot[] = [];
  for (const day of [...days].reverse()) {
    const ofDay = sessionsNewestFirst
      .filter((session) => session.businessDay === day)
      .reverse() // 变成当天从早到晚
      .slice(0, perDay);
    for (let nth = 1; nth <= perDay; nth += 1) {
      slots.push({ day, sameDay: day === asOfDay, nth, session: ofDay[nth - 1] ?? null });
    }
  }
  return slots;
}

const nums = (values: Array<number | null>): number[] => values.filter((v): v is number => typeof v === 'number');

/**
 * 红线分流。R1/R4 纯代码判定直接生效；R2/R3 是模型判的，要有 CONFIRMED 裁定才算生效——
 * 而人工裁定已于 2026-08-24 取消，所以它们实际上永远落在 pending 这一档。
 * ★ 分流逻辑一行没改 ★ 库里还留着 3 条历史裁定，重算那几天时照旧认。
 */
function splitRedlines(sessions: WindowSession[], recentDays: string[]) {
  const effective: string[] = [];
  const pending: string[] = [];
  for (const session of sessions) {
    // 方案口径：红线只看**最近 2 天**，不是整个 6 局窗口。
    // 前天踩的红线，今天不该继续压着一个已经改过来的人。
    if (!recentDays.includes(session.businessDay)) continue;
    for (const redline of session.redlines) {
      /**
       * ★ 用 isHardRedline，不要写死 'R1' ★（2026-08-24 修）
       * 2026-08-23 加的 **R4「用中文作答」同样是 hard**（纯代码查汉字，没有解释空间），
       * 而这里只认 R1，于是 R4 掉进 pending 那一档——一条 100% 确定的事实
       * 被摆成「等人来判」，而人工裁定当天已经取消，永远没人来判。
       * 可靠性分级的真源只有 `REDLINE_RELIABILITY` 一处，读它就不会再走偏。
       */
      if (isHardRedline(redline.code) || redline.status === 'CONFIRMED') {
        effective.push(`${session.businessDay} ${redline.code}`);
      } else if (redline.status !== 'DISMISSED') {
        pending.push(`${session.businessDay} ${redline.code}`);
      }
    }
  }
  return { effective, pending };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** 中位数可能是 .5，别把 63.5 印成 64——那 0.5 分正是他今天差的那口气 */
export function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : String(round1(n));
}

/**
 * 样本不足那句话。
 * ★ 必须写明缺在哪一天、还差几局 ★（方案 9.2 第三条原则）
 * 否则新人第一天看到「未达标」会以为自己考砸了——其实只是还没考够。
 *
 * ★ 缺考和证据不足要分开说 ★ 前者是他没考，后者是系统没评出来。
 * 混成一句「样本不足」，被系统坑了的人会以为是自己的问题。
 */
function sampleTextOf(
  missingByDay: Array<{ day: string; missing: number }>,
  preciseCount: number,
  asOfDay: string,
  dayInProgress: boolean,
): string {
  const perDay = ADMISSION_CONFIG.sessionsPerExam;
  const need = ADMISSION_CONFIG.windowSessions;

  // ★ 还没过完的那天不算缺考 ★ 上午十点告诉一个人他「今天整天缺考」是假的，
  // 而且界面上那三格画的是「·」（还没考到）——一句话和它旁边的格子自相矛盾。
  const todayGap = dayInProgress ? missingByDay.find((item) => item.day === asOfDay) : undefined;
  const missed = dayInProgress ? missingByDay.filter((item) => item.day !== asOfDay) : missingByDay;
  const tail = todayGap ? `今天还没考完，那 ${todayGap.missing} 局不算缺考。` : '';

  if (missed.length > 0) {
    const parts = missed.map(({ day, missing }) =>
      missing >= perDay ? `${day} 整天缺考` : `${day} 缺 ${missing} 局`,
    );
    // ★ 必须写这一句 ★ 缺的局补不回来——窗口只认当天考的，今天再补考也填不进昨天那三格。
    // 不写清楚，人会以为「明天多考三局就补上了」，白等一天。
    return `${parts.join('，')}。缺考算不达标。判定要 ${ADMISSION_CONFIG.windowDays} 个业务日各 ${perDay} 局、共 ${need} 局，缺的局补不回来（窗口只认当天考的）；连着考满两天才会重新达标。${tail}`;
  }
  if (todayGap) {
    return `今天还没考完（还差 ${todayGap.missing} 局），考满 ${perDay} 局才出判定。`;
  }
  if (preciseCount < ADMISSION_CONFIG.preciseMin) {
    const short = ADMISSION_CONFIG.preciseMin - preciseCount;
    return `${need} 局都考了，但有 ${short} 局证据不足、没拿到精确局分，本轮不构成判定。这不是你的问题，也不记不达标。`;
  }
  return '';
}

/**
 * 判某一个业务日。
 *
 * @param sessionsNewestFirst 该人的考试局，**从新到旧**。演习局不要传进来。
 * @param asOfDay 被判定的业务日。窗口 = 这一天 + 前一个业务日，各 3 局。
 *
 * ★ 必须传 asOfDay ★（2026-08-21）没有它就只能「取最近 6 局」，
 * 而那正是让缺考的人一直挂着 ✓ 的那个 bug。签名强制要求它，
 * 是为了让每个调用点都必须明确回答「你在判哪一天」。
 */
export function judgeWindow(
  sessionsNewestFirst: WindowSession[],
  asOfDay: string,
  opts: {
    /**
     * 工作日历。★ 必填 ★ 它决定「前一个业务日」是哪一天——
     * 国庆后第一天 10-08 的前一个业务日应该是 09-30，不是 10-07。
     * 没有默认值：忘了传是**类型错误**，不是静默退回「只跳周末」。
     * 后者才是最危险的失败模式——功能看着在，国庆当天才发现没生效。
     */
    calendar: WorkCalendar;
    /**
     * asOfDay 这一天**还没过完**（考试还能补上）。
     *
     * ★ 引擎不读时钟，只能由调用方回答 ★ 结算跑的都是已经过去的日子，传 false（默认）；
     * 界面上「今天」那一行传 true。差别只在文案：true 时今天的空格说成
     * 「今天还没考完」而不是「整天缺考」——上午十点说人家整天缺考是假的。
     * ★ 只影响文案，不影响判定 ★ 不管哪种，6 格没齐都一样是「不构成判定」。
     */
    dayInProgress?: boolean;
  },
): WindowVerdict {
  // ★ 一条判定条件都没启用时必须炸，不许静默放行 ★（2026-08-22 加）
  // 下面 passed 那一步是 `gates.every(gate => gate.passed)`，而 **every 对空数组恒真**——
  // 有人想「临时关掉判定」把 activeGates 清空，结果不是「谁都判不了」，
  // 是**六局全 0 分也判达标、全员当场拿到分配权**，而且界面上一片绿，没有任何异常。
  // 这是典型的低概率高后果：真发生了，等发现时询盘已经分出去了。
  if (ADMISSION_CONFIG.activeGates.length === 0) {
    throw new Error(
      'ADMISSION_CONFIG.activeGates 是空的——一条判定条件都没启用。' +
        '空数组不等于「关掉判定」，它会让所有人无条件达标。要停判定请另走开关，不要清空这个数组。',
    );
  }
  const slots = buildWindow(sessionsNewestFirst, asOfDay, opts.calendar);
  const window = slots
    .map((slot) => slot.session)
    .filter((session): session is WindowSession => session !== null);
  const sampleCount = window.length;
  const precise = window.filter((s) => s.precise && s.rawScore !== null);
  const preciseCount = precise.length;

  // 缺考明细，按日期从新到旧——先说今天缺，再说昨天缺
  const missingByDay = [...new Set(slots.map((slot) => slot.day))]
    .sort((a, b) => (a < b ? 1 : -1))
    .map((day) => ({ day, missing: slots.filter((slot) => slot.day === day && !slot.session).length }))
    .filter((item) => item.missing > 0);

  // 红线窗口就是这个判定窗口的那两天（方案：最近 2 天内有无生效红线）
  const recentDays = recentBusinessDays(ADMISSION_CONFIG.redlineWindowDays, asOfDay, opts.calendar);
  const { effective, pending } = splitRedlines(window, recentDays);

  const medianScore = preciseCount > 0 ? median(precise.map((s) => s.rawScore as number)) : null;
  const insightValues = nums(window.map((s) => s.insight));
  const insightMedian = insightValues.length > 0 ? median(insightValues) : null;
  const answerValues = nums(window.map((s) => s.answerQuality));
  const answerMedian = answerValues.length > 0 ? median(answerValues) : null;

  // ★ 缺考算不达标 ★（2026-08-22 王老师定，改了 v1.1 的原口径）
  // 原来 6 格没凑齐一律 passed=null「不构成判定」——于是**缺考成了保住资格的最优策略**：
  // 不考就永远判不出来，连续天数不涨，分配权永远不掉。王老师原话：
  // 「缺考肯定算不达标啊……如果缺考都能算达标的话，那大家都不考了呀，这肯定是不行」。
  //
  // 现在两种缺口分开处理：
  //   · **格子空着**（他没考，包括训练期没解锁那种）→ 判**不达标**，连续天数照加
  //   · **考了但没评出分**（证据不足）→ 仍然「不构成判定」，那不是他的错
  //
  // ★ 今天那几格不算 ★ dayInProgress=true 时今天还能补考，上午十点判他缺考是假的。
  // 结算跑的都是已经过去的日子，传 false，所以这一条只影响界面上「今天」那一行。
  const excusedToday = opts.dayInProgress
    ? (missingByDay.find((item) => item.day === asOfDay)?.missing ?? 0)
    : 0;
  const absentCount = missingByDay.reduce((sum, item) => sum + item.missing, 0) - excusedToday;
  const complete = sampleCount >= ADMISSION_CONFIG.windowSessions;
  const preciseOk = preciseCount >= ADMISSION_CONFIG.preciseMin;
  const enough = complete && preciseOk;

  /**
   * ★ 门槛永远是 65 ★（王老师 2026-08-23 裁定）
   *
   * 曾经让难度系数把门槛也一起缩放，被否了。达标线是要跟业务员讲的那句话，
   * 它必须是个定数——**难度系数调的是「拿到 65 有多难」，不是「多少分算过」**。
   * 系数只作用在局分上，见 `engine/difficulty.ts`。
   */
  const scoreOk = medianScore !== null && medianScore >= ADMISSION_CONFIG.medianScoreMin;
  const insightOk = insightMedian !== null && insightMedian >= ADMISSION_CONFIG.insightMedianMin;
  const redlineOk = effective.length === 0;
  const answerOk = answerMedian !== null && answerMedian >= ADMISSION_CONFIG.answerQualityMedianMin;

  const scoreGap =
    medianScore === null
      ? ADMISSION_CONFIG.medianScoreMin
      : Math.max(0, round1(ADMISSION_CONFIG.medianScoreMin - medianScore));

  // ★ 未达标一律给距离 ★（方案 9.7 措辞铁律）「差 4 分」能行动，「未达标」不能
  const allGates: GateView[] = [
    {
      key: 'score',
      label: '局分',
      passed: scoreOk,
      text:
        medianScore === null
          ? '还没有可精确评分的局'
          : scoreOk
            ? `中位数 ${fmt(medianScore)}`
            : `中位数 ${fmt(medianScore)}，距 ${ADMISSION_CONFIG.medianScoreMin} 差 ${fmt(scoreGap)} 分`,
    },
    {
      key: 'insight',
      label: '洞察力',
      passed: insightOk,
      text:
        insightMedian === null
          ? '本窗口没有可评洞察力的局'
          : insightOk
            ? `中位数 ${fmt(insightMedian)}`
            : `中位数 ${fmt(insightMedian)}，距 ${ADMISSION_CONFIG.insightMedianMin} 差 ${fmt(
                ADMISSION_CONFIG.insightMedianMin - insightMedian,
              )} 分`,
    },
    {
      key: 'redline',
      label: '红线',
      passed: redlineOk,
      text: redlineOk
        ? pending.length > 0
          ? `最近 ${ADMISSION_CONFIG.redlineWindowDays} 天无生效红线（另有 ${pending.length} 条模型判定，仅作反馈）`
          : `最近 ${ADMISSION_CONFIG.redlineWindowDays} 天无生效红线`
        : `最近 ${ADMISSION_CONFIG.redlineWindowDays} 天有 ${effective.length} 条生效红线：${effective.join('、')}`,
    },
    {
      key: 'answer',
      label: '复盘',
      passed: answerOk,
      text:
        answerMedian === null
          ? '还没有复盘作答记录'
          : answerOk
            ? `作答质量中位数 ${fmt(answerMedian)}`
            : `作答质量中位数 ${fmt(answerMedian)}，距 ${ADMISSION_CONFIG.answerQualityMedianMin} 差 ${fmt(
                ADMISSION_CONFIG.answerQualityMedianMin - answerMedian,
              )}`,
    },
  ];

  // ★ 只有启用的条目参与「过没过」★ 其余照算照存，不参与判定
  const gates = allGates.filter((gate) => ADMISSION_CONFIG.activeGates.includes(gate.key));

  const passed: boolean | null =
    absentCount > 0
      ? false // 缺考 → 不达标
      : !complete
        ? null // 今天还没考完，还能补
        : !preciseOk
          ? null // 考了，系统没评出分——不记他不达标
          : gates.every((gate) => gate.passed);

  return {
    sampleCount,
    preciseCount,
    enough,
    medianScore,
    insightMedian,
    answerMedian,
    passed,
    gates,
    allGates,
    effectiveRedlines: effective,
    pendingRedlines: pending,
    scoreGap,
    sampleText: sampleTextOf(missingByDay, preciseCount, asOfDay, opts.dayInProgress ?? false),
    slots,
    missingByDay,
  };
}

/**
 * 判定口径的指纹。**改了任何一个影响「过没过」的阈值，这串就会变。**
 *
 * ★ 它要解决的是台账上最后一个黑洞 ★（2026-08-22）
 * 历史行的结论读的是当晚的留档，而左边那 6 个格子是现算的。
 * 于是「改了判定口径但没重算」会造出一种很难发现的错账：
 * **格子按新规则摆、结论按老规则给**，两边都长得很正常。
 * 日历那半边已经有三向体检（`ledger-audit.ts`）；这半边此前完全靠流程——
 * 「改完记得整体重算」，靠人记。
 *
 * 现在把指纹写进 `DailyEvaluation.detail`，体检时比一比就知道哪几天是老口径算的。
 *
 * ★ 只放会改变判定结果的东西 ★ `dailyDrillMin`、`validDrillMinTurns` 那些是闸门参数，
 * 改了它们不会让**已经算出来的**判定变得不对，不进指纹——否则每调一次解锁门槛，
 * 全公司的历史留档都会被报成待重算，人就再也不看这个提示了。
 */
export function judgementFingerprint(): string {
  const c = ADMISSION_CONFIG;
  return [
    `gates=${[...c.activeGates].sort().join('+')}`,
    // 难度系数不进指纹：它不改判定口径，只改单局分数。
    // 每一局按哪个系数打的记在 `Session.difficultyFactor` 与 `Score.difficultyFactor` 上。
    `score>=${c.medianScoreMin}`,
    `window=${c.windowDays}x${c.sessionsPerExam}`,
    `precise>=${c.preciseMin}`,
    `insight>=${c.insightMedianMin}`,
    `answer>=${c.answerQualityMedianMin}`,
    `redlineDays=${c.redlineWindowDays}`,
    `failsToSuspend=${c.consecutiveFailsToSuspend}`,
  ].join('|');
}

/** 启用的那几条现在是什么，写成一句人话。给「判定口径」这类说明用 */
export function activeGateText(): string {
  const parts: string[] = [];
  if (ADMISSION_CONFIG.activeGates.includes('score')) parts.push(`局分中位数 ≥${ADMISSION_CONFIG.medianScoreMin}`);
  if (ADMISSION_CONFIG.activeGates.includes('insight')) parts.push(`洞察力中位数 ≥${ADMISSION_CONFIG.insightMedianMin}`);
  if (ADMISSION_CONFIG.activeGates.includes('redline')) parts.push(`最近 ${ADMISSION_CONFIG.redlineWindowDays} 天无生效红线`);
  if (ADMISSION_CONFIG.activeGates.includes('answer')) parts.push(`复盘中位数 ≥${ADMISSION_CONFIG.answerQualityMedianMin}`);
  return parts.join('／');
}

/**
 * 首页状态条那一行（方案 9.2）。
 * ★ 只列启用的条目 ★ 判定只看局分时，再摆「洞察✓ 红线✓ 复盘✓」是误导——
 * 那三个勾现在不决定任何事。
 */
export function statusLine(v: WindowVerdict): string {
  if (!v.enough) return v.sampleText;
  const window = ADMISSION_CONFIG.windowSessions;
  const score = fmt(v.medianScore ?? 0);
  const scoreGate = v.gates.find((gate) => gate.key === 'score');
  const head = scoreGate && !scoreGate.passed
    ? `最近 ${window} 局中位数 ${score} · 距 ${ADMISSION_CONFIG.medianScoreMin} 差 ${fmt(v.scoreGap)} 分`
    : `最近 ${window} 局中位数 ${score}`;
  if (v.passed) return v.gates.length > 1 ? `${head} · 全过 ✓` : `${head} · 达标 ✓`;
  const rest = v.gates
    .filter((gate) => gate.key !== 'score')
    .map((gate) => `${gate.label}${gate.passed ? '✓' : '✗'}`)
    .join(' ');
  return rest ? `${head} · ${rest}` : head;
}

/* ────────────────── 当日考试状态 ────────────────── */

export type ExamState = '已考' | '进行中' | '未考' | '已作废';

/**
 * 当日考试考到什么程度了。
 *
 * ★ 数已出分的局，不读 ExamAttempt.verdict ★（2026-08-21 修）
 * 原来三处（今日判定表、待办条「今日未考」、todayExamState）各写一遍
 * `attempt.verdict === null ? '进行中' : '已考'`。那个 verdict 是评完第三局时
 * **自动交卷**写上去的，而自动交卷自己就承认可能失败——`score/route.ts` 里那段
 * catch 的注释原话是「就算这里失败了也不影响判定：每晚结算读的是局和分，
 * 不读考试的结算状态」。
 *
 * 于是就出现了王老师圈出来的那一行：三局都考完、都出了分（68 72 60），
 * 判定也已经拿这三局算出中位 62.5 判了「局分✗」，同一行的「当日基本任务」
 * 却写着「✗ 考试没打完」，人还同时被记进待办条的「今日未考」。
 * **判定读局、基本任务读结算标志——两列证据不同源，必然打架。**
 *
 * 现在统一按 v1.1 自己那条原则来：读局，不读结算状态。
 *
 * @param scoredToday 当日已出分的考试局数
 * @param started 当日开过考（有 ExamAttempt）。开考瞬间 3 局就全生成好了，
 *                但一局没打完时 scoredToday 还是 0，靠这个才分得出「开了没打」和「没开」
 */
export function examStateOf(
  scoredToday: number,
  started: boolean,
  /**
   * 这一天**已经过完了**（历史台账那些行）。
   *
   * ★ 引擎不读时钟，只能由调用方回答 ★ 和 judgeWindow 的 dayInProgress 是同一个道理。
   *
   * ★ 为什么要有它 ★（2026-08-22）`examStateOf(0, true)` 恒等于「进行中」——
   * 一个三周前开了考、一局都没打完的日子，今天翻台账看还写着
   * 「进行中 · 考试差 3 局」，像是那场考试还在等他回去接着打。它早就回不去了：
   * 考试一天一场，那天已经过完，那几局永远补不上。
   * 说成「已作废」，主管才知道这一行不用再等，也不用去催他「打完」。
   *
   * ★ 只影响措辞，不影响判定 ★ 那几个空格无论叫什么，在判定窗口里一样是缺考。
   */
  dayOver = false,
): ExamState {
  if (scoredToday >= ADMISSION_CONFIG.sessionsPerExam) return '已考';
  if (started || scoredToday > 0) return dayOver ? '已作废' : '进行中';
  return '未考';
}

/* ────────────────── 训练期开考闸门 ────────────────── */

export interface UnlockState {
  /** 当日已完成的有效演习局数 */
  done: number;
  required: number;
  unlocked: boolean;
  /** 这些局里有几局不是简单局 */
  nonSimpleDone: number;
  /** 至少要几局不是简单局。见 ADMISSION_CONFIG.minNonSimpleDrillsForUnlock */
  nonSimpleRequired: number;
  /** 首页解锁进度卡的正文 */
  text: string;
}

/**
 * 训练期：当日 ≥3 局演习才解锁考试（方案 9.1 / 9.3）。
 *
 * ★ 只看局数，不看分数 ★ 这是文案里必须写死的一句话——
 * 被系统拦住的那一瞬间，人会默认「是我打得不够好」。
 *
 * ★ 但「一局」有门槛 ★（2026-08-22 立，2026-08-28 换第三条）
 * 聊满 6 轮 + 出了报告 + **这一局真干了活**（至少解开一张暗牌，或至少开口问过一项六要素），
 * 口径在 `settlement.countDrillsToday`，判据在 `engine/facts.didRealWork`。
 * 第三条原本是「做完复盘」——复盘 2026-08-28 改成可选之后那条链断了，换成了现在这条。
 * 规则本身收在考前必读里；一个练了三局却还差一局的人第一反应一定是「系统坏了」，
 * 所以那一页必须写清楚第三条到底要什么。
 *
 * ★ 第二道条件：不能三局全是简单局 ★（2026-08-23，随简单档 3→18 封一起加）
 * `nonSimpleToday` 不传时默认等于 `doneToday`——即「全都算数」，
 * 与加这条之前的行为一致，老调用点不传也不会被误拦。
 */
export function unlockState(
  doneToday: number,
  stage: 'TRAINING' | 'ACTIVE',
  nonSimpleToday: number = doneToday,
): UnlockState {
  const required = ADMISSION_CONFIG.dailyDrillMin;
  const nonSimpleRequired = ADMISSION_CONFIG.minNonSimpleDrillsForUnlock;
  if (stage === 'ACTIVE') {
    return {
      done: doneToday,
      required: 0,
      unlocked: true,
      nonSimpleDone: nonSimpleToday,
      nonSimpleRequired: 0,
      text: '在岗期不要求演习局，今天可以直接考。',
    };
  }
  const countShort = Math.max(0, required - doneToday);
  const nonSimpleShort = Math.max(0, nonSimpleRequired - nonSimpleToday);
  const unlocked = countShort === 0 && nonSimpleShort === 0;
  return {
    done: doneToday,
    required,
    unlocked,
    nonSimpleDone: nonSimpleToday,
    nonSimpleRequired,
    // ★ 只说他该做什么，不说「练得好不好都行」★（2026-08-23 王老师定）
    // 原文是「练得好不好不影响解锁——练够就给考」。那是在解释机制，
    // 读起来却像在告诉他可以敷衍着凑数——一句本来只想说明规则的话，
    // 变成了一句鼓励糊弄的话。规则该在考前必读里写，这里只留下一步动作。
    // ★ 只留一句动作 ★（2026-08-23 王老师定）后面原来还跟着「一局要聊满 6 轮、
    // 并做完复盘出报告才算数」——那是规则，写在考前必读第三节里。
    //
    // ★ 局数够了但全是简单局，必须单独说 ★（2026-08-23）
    // 否则界面会显示「3 / 3 局」却依然不给考，那是最招人骂的一种拦法：
    // 数字已经满了，人不可能猜到差的是难度。
    text: unlocked
      ? `今日 ${doneToday} / ${required} 局已达标 —— 考试已解锁`
      : countShort > 0 && nonSimpleShort > 0
        ? `再练 ${countShort} 局解锁今天的考试，其中至少 ${nonSimpleShort} 局要选标准或困难。`
        : countShort > 0
          ? `再练 ${countShort} 局解锁今天的考试。`
          : `局数够了，但还差 ${nonSimpleShort} 局标准或困难 —— 不能三局全挑简单。`,
  };
}

/**
 * 人工设定还作不作数。
 *
 * ★ 只管设定当天 ★（2026-08-22 王老师定，改了方案 v1.1 第二节的原规则）
 * 原规则是「一旦人工设定，自动判定永远不再改这个人，只能由人点恢复自动」。
 * 实际跑下来是：主管改完就忘了，人一直锁在在岗期，系统算出来该退训练期也不动。
 * 主管不可能每天盯着——所以改成「主管只对某一天负责，第二天交回系统」。
 *
 * 规则一句话：**主管在 D 日设的，管的就是 D 日；D 日的成绩一结算，就交回系统。**
 * 结算比 D 更早的日子（补算历史）时它仍然作数——拿前天的成绩推翻你今天的决定，
 * 那是倒着来。
 */
export function overrideStillActive(input: {
  /** User.stageOverride */
  stageOverride: boolean;
  /** 主管设定那一刻所在的业务日；没被人工设定过就是 null */
  setOnDay: string | null;
  /** 正在结算的业务日 */
  settlingDay: string;
}): boolean {
  if (!input.stageOverride || !input.setOnDay) return false;
  return input.settlingDay < input.setOnDay;
}

/* ────────────────── 一天一场：考完就锁 ────────────────── */

/** 今天这个人的考试场次处于什么状态 */
export type TodayAttempt = 'none' | 'running' | 'done';

/**
 * 今天还能不能开考。
 *
 * ★ 一天一场，考完就锁 ★（2026-08-22 王老师：考完就锁住考试按钮，同一天不能再考）
 * 后端本来就拦得死（`determineAttempt` + 事务里的行锁 + 唯一场次查重），
 * 可**按钮照样亮着写「开始今天的考试」**，点下去才弹一句「今天这场考试已经考完了」。
 * 拦住了但骗了人一下，那不叫锁。
 *
 * ★ 做成纯函数是为了让按钮和接口读同一份判断 ★ 各写一套，迟早一边说能考一边不给考。
 */
export function examGateOf(input: {
  /**
   * 他走哪条考试轨。null = 不参加考试（主管、身份待确认）。
   *
   * ★ 2026-08-24 从 `admissionUser: boolean` 改成三态 ★
   * 布尔只答得出「是不是实习准入」，于是正式业务员被归进「不是」那一档整条挡掉：
   * 考试按钮永远不亮，可版头偏偏还渲染着「今日考试 未开始」。
   * 现在两条轨都能考，**区别只在下面那道演习解锁闸**。
   */
  track: ExamTrack;
  todayAttempt: TodayAttempt;
  stage: Stage;
  /** 今日已完成的有效演习局数。在岗期与周考轨都用不上 */
  drillsToday: number;
  /**
   * 那些局里有几局不是简单局。不传＝当作全都不是简单局，
   * 即退回 2026-08-23 之前的行为，老调用点不会被误拦。
   */
  nonSimpleDrillsToday?: number;
}): { canStart: boolean; reason: string } {
  if (input.track === null) return { canStart: false, reason: '当前账号不参加演习考试' };
  // ★ 一天一场对两条轨都成立 ★ 王老师顾虑的「一天考多次就会一直刷分、
  // 没时间维护现有客户」，正式业务员一样适用
  if (input.todayAttempt === 'running') return { canStart: false, reason: '今天这场还没打完' };
  if (input.todayAttempt === 'done') {
    return {
      canStart: false,
      reason: `今天这场考完了 · 每人每天 1 场（${ADMISSION_CONFIG.sessionsPerExam} 局），明天再来`,
    };
  }
  /**
   * ★ 「当日先练 3 局」只拦准入轨 ★（2026-08-24 王老师定）
   * 那道闸的用意是逼训练期的实习生每天刻意练习，换来一次考试机会。
   * 正式业务员的要求是「每周至少 2 场」，练不练由他自己定——
   * 在这里拦他，等于把实习生的日节奏套到一个不受准入约束的人头上。
   */
  if (input.track === 'WEEKLY') return { canStart: true, reason: '' };
  const unlock = unlockState(input.drillsToday, input.stage, input.nonSimpleDrillsToday);
  if (!unlock.unlocked) {
    // ★ 局数满了却没解锁时，理由要写难度，不能只甩一个 3/3 ★（2026-08-23）
    return {
      canStart: false,
      reason:
        unlock.done >= unlock.required
          ? `演习 ${unlock.done}/${unlock.required} 局已够，但标准或困难只有 ${unlock.nonSimpleDone}/${unlock.nonSimpleRequired} 局，考试还没解锁`
          : `演习 ${unlock.done}/${unlock.required} 局，考试还没解锁`,
    };
  }
  return { canStart: true, reason: '' };
}
