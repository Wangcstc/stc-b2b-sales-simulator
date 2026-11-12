import { activeGateText, ADMISSION_CONFIG } from '@/lib/admission-v11';
import { WEEKLY_EXAM_CONFIG } from '@/lib/weekly-exam';
import { FLOW_LOGINS, FLOW_SESSIONS } from './shared';
import type { HelpPage } from './types';

/**
 * 教练台（/replay）的帮助内容 —— 只给主管看
 *
 * ★ 数字一律从 ADMISSION_CONFIG 取 ★ 真源是 src/lib/admission-v11.ts。
 * 那是开发才需要知道的事，写在注释里，不摆到界面上占地方。
 *
 * ★ 格子图例的真源在 components/TaskCells.tsx 的 markOf() ★ 那边改了这里要跟着改。
 */
const C = ADMISSION_CONFIG;
const W = WEEKLY_EXAM_CONFIG;

export const COACH_HELP: HelpPage = {
  id: 'coach',
  title: '教练台',
  route: '/replay',
  audience: 'lead',
  intro: '今日判定、历史记录、登录流水、标尺校准、考题池，全在这一页。只能看，不能替人聊——替人聊出来的分是假的。',
  sections: [
    {
      id: 'coach-scope',
      title: '这一页管什么',
      summary: '今日判定、历史记录、登录流水都在这儿。只能看，不能替人聊。',
      body: () => (
        <>
          <p>今日判定、历史记录、登录流水，都在这一页。</p>
          <p>
            <b>只能看，不能替人聊</b> —— 替人聊出来的分是假的。
          </p>
        </>
      ),
    },
    {
      id: 'coach-verdict',
      title: '今日判定怎么算',
      summary: '只算考试局：最近 6 局中位数达标就算过，连着 2 天不达标退回训练期。',
      body: () => (
        <>
          <p>
            <b>只算考试局</b>：最近 {C.windowDays} 个业务日、每天 1 场考试 {C.sessionsPerExam} 局，
            一共 {C.windowSessions} 局，这几局的<b>{activeGateText()}</b> 就算达标。
            连着 {C.consecutiveFailsToSuspend} 天没达标，退回训练期。
          </p>
          <p>
            <b>自由询盘是练手场，打多少局、打多少分都不进这里</b> —— 它只管解锁考试。
          </p>
          <p>
            <b>缺考算不达标。</b>格子空着就是不达标，连续天数照加 —— 不考不是躲过去，是直接判不达标。
            而且<b>补不回来</b>：今天多打几局也填不进左边那几格。
          </p>
          <p>
            <b>只有两种情况不算他的</b>：今天还没考完（还能补）；考了但系统没评出分（证据不足）。
            这两种不记不达标，也不加连续天数。
          </p>
          <p>
            <b>今天这几行是现算的</b> —— 刚考完的局立刻算进去，看到的就是此刻过没过；
            下面历史台账里那些行，是当晚结算时存下来的。
          </p>
          <p>
            <b>洞察力、复盘、红线照常评，也照常写进报告，但不参与判定</b>（2026-08-21 起）。
            旧门槛留着备查：洞察力 ≥{C.insightMedianMin}、复盘 ≥{C.answerQualityMedianMin}、
            红线看最近 {C.redlineWindowDays} 天。这些数字<b>要改找开发</b>：改一处全站生效，
            动了判定窗口还得把历史整体重算一遍。
          </p>
        </>
      ),
    },
    {
      id: 'coach-cells',
      title: '那一排格子怎么看',
      summary: '六格全是考试局，左暗是上一个业务日、右亮是今天。红催考试，橙催演习。',
      body: () => (
        <>
          <p>
            六个格子装的都是<b>考试局</b>：左边 {C.sessionsPerExam} 格是<b>上一个业务日</b>考的（颜色暗），
            右边 {C.sessionsPerExam} 格是今天的（颜色亮），后面那个中位数就是这几个分算出来的。
          </p>
          <ul className="help-legend">
            <li>
              <b className="num">68</b> 考了，68 分。<span className="faint">不用动</span>
            </li>
            <li>
              <b className="num" style={{ color: 'var(--bad)' }}>✗</b>{' '}
              <b>有资格却没来考</b> —— 不是考砸了，是没考。<span className="faint">要催的是考试</span>
            </li>
            <li>
              <b className="num" style={{ color: 'var(--warn)' }}>锁</b>{' '}
              <b>那天没资格考</b> —— 当日演习没练够，考试没解锁。
              <span className="faint">要催的是演习，不是考试</span>
            </li>
            <li>
              <b className="num" style={{ color: 'var(--muted)' }}>?</b> 考了，但
              <b>系统没评出分</b>（证据不足）。<span className="faint">不记他的，要找的是开发</span>
            </li>
            <li>
              <b className="num" style={{ color: 'var(--faint)' }}>·</b>{' '}
              <b>还轮不到他</b> —— 今天还没考到，或那天他还没入职。
              <span className="faint">什么都不用做；具体是哪一种，看最右边「差在哪」</span>
            </li>
          </ul>
          <p className="faint">
            一个意思只有一个符号，一种颜色只对应一件要做的事：
            <b style={{ color: 'var(--bad)' }}>红＝催考试</b>、
            <b style={{ color: 'var(--warn)' }}>橙＝催演习</b>、灰＝不用管。
          </p>
        </>
      ),
    },
    {
      id: 'coach-basic-task',
      title: '「当日基本任务」这一列',
      summary: '训练期＝先练够 3 局解锁考试再考 1 场；在岗期＝直接考 1 场。',
      body: () => (
        <p>
          <b>训练期</b>＝今天先练够 {C.dailyDrillMin} 局演习
          {C.minNonSimpleDrillsForUnlock > 0
            ? `（简单局也算，但其中至少 ${C.minNonSimpleDrillsForUnlock} 局要是标准或困难）`
            : '（简单局也算）'}
          解锁考试，再考 1 场；<b>在岗期</b>＝直接考 1 场。
        </p>
      ),
    },
    FLOW_SESSIONS,
    FLOW_LOGINS,
    {
      id: 'coach-calibration',
      title: '难度系数（标尺校准）',
      summary: '达标线永远是中位数 65 分。系数调的是「拿到 65 分有多难」。',
      body: () => (
        <>
          <p>
            <b>达标线永远是「最近 {C.windowSessions} 局局分中位数 ≥ {C.medianScoreMin} 分」</b>。
            系数不会改这条线。
          </p>
          <p>
            系数调的是<b>拿到 {C.medianScoreMin} 分有多难</b>：系数越大，同样的表现，分数越低。
          </p>
          <p>
            <b>1.0 = 现在的标准。</b>先按 1.0 跑几天看分数分布 —— 普遍偏高就往上加一档，
            偏低就往下减一档。
          </p>
          <p>
            真正要看的是面板上那句<b>「要打出 X 分的水平，才拿得到 {C.medianScoreMin} 分」</b>，
            X 就是你实际在调的东西。
          </p>
          <p>
            折算之后的分才是全系统认的局分：段位 D1–D5、红旗、最近 {C.windowSessions} 局中位数、
            准入判定，读的都是它。
          </p>
          <p>
            原始分照常存着。折算过的局，报告里会写明「原始 70 → 系数 1.2 → 最终 65」，
            不会让人以为分是凭空少的。
          </p>
          <p>
            <b>次个业务日生效。</b>今天已经开的局、已经考的场，仍按开局时的系数出分 ——
            同一场考试的三局要一起算中位数，不能落到两套口径上。
          </p>
        </>
      ),
    },
    {
      id: 'coach-exam-pool',
      title: '考题池',
      summary: '考题在别处一律不显示，这里是唯一能审题的地方。',
      body: () => (
        <>
          <p>
            考题在首页和「模拟询盘」里一律不显示 —— 出现在那儿就等于泄题。
            <b>这里是唯一能审题的地方。</b>
          </p>
          <p>
            每套都是照着一个演习局改的：<b>暗牌机制和考点完全一样，换的是客户、产品和数字</b>，
            练过母本的人认不出是同一局。
          </p>
          <p>
            想看暗牌细节，去题库包的 <code className="mono">personas/</code> 目录翻 JSON —— 这里只摆到「几张」为止。
          </p>
        </>
      ),
    },
    {
      id: 'coach-regular-week',
      title: '正式业务员的周考',
      summary: '正式业务员不参加准入。周考只记录，不接任何后果。',
      body: () => (
        <>
          <p>
            正式业务员<b>不参加准入</b>，今日判定表里没有他们。
            他们的要求是<b>每周至少 {W.examsPerWeek} 场</b>考试（{W.sessionsPerWeek} 局出分），
            周一到周日算一周。
          </p>
          <p>
            <b>只算考试局。</b>他们练手不限次数，练多少局都不进这张表。
          </p>
          <p>
            中位数旁边那条 {W.medianScoreMin} 分是<b>参考线</b>，与实习业务员同一把尺，方便横向比。
            周考<b>不接任何后果</b>：没考满不影响询盘分配、不动期别、不动权限，
            这一行只是让你知道谁这周还没动。
          </p>
          <p>「进行中」＝这一周还没过完，还没到下结论的时候。</p>
        </>
      ),
    },
  ],
};
