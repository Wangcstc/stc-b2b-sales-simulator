import { ADMISSION_CONFIG as C, SETTLE_LOCAL_TIME } from '@/lib/admission-v11';
import { WEEKLY_EXAM_CONFIG as W } from '@/lib/weekly-exam';
import type { HelpPage } from './types';

/**
 * 新人必读 —— 原来是右上角「❓」弹窗里的全部内容（2026-08-27 搬进来）
 *
 * ★ 为什么要搬 ★
 * 搬之前版头上有两个帮助入口：一个 ❓ 弹窗（讲「一局怎么打」），
 * 加上页面里各处的 ?（讲「这个字段是什么」）。两种问号长得一样、点开完全不同，
 * 人分不清该点哪个——截图里一屏六个问号，一半的困惑来自这儿。
 * 现在版头那个入口指向 /help，这一页就是它的第一组内容：
 * **一个帮助入口，一处内容**。
 *
 * ★ 挑进来的标准没变 ★ 当场做决定要用到、记错了会直接扣分。
 * 手册全文的真源仍在知识库的《新人使用说明》，这里不搬全文。
 */
export const BASICS_HELP: HelpPage = {
  id: 'basics',
  title: '新人必读',
  route: '/',
  audience: 'all',
  intro: '当场做决定会用到、记错了会直接扣分的那些规则。第一次来先把这一组看完，其余各页的说明用到再查。',
  sections: [
    {
      id: 'basics-flow',
      title: '一局怎么打',
      summary: '回答一个问题，必抛一个问题。20 轮封顶，报价也占一轮。',
      body: () => (
        <>
          <ul>
            <li>
              <b>第 1 轮</b>　招呼 + 回应他问的 + 抛第一个问题（合成一条发出去）
            </li>
            <li>
              <b>第 2–12 轮</b>　六要素逐个踩到底。<b>回答一个问题，必抛一个问题</b>
            </li>
            <li>
              <b>第 13–16 轮</b>　数量确认死了才报价，走「报价」按钮
            </li>
            <li>
              <b>第 17–19 轮</b>　确认下一步，自己点「结束并复盘」
            </li>
          </ul>
          <p className="faint">
            你发一句 = 1 轮，<b>提交报价也占一轮</b>，20 轮封顶。
            回完就等着，进程立刻停摆 —— <b>连续 3 轮问不出新信息，客户直接走人判负</b>。
          </p>
          <p>
            <b>客户全程说英文。</b>你可以打中文 —— 按 <span className="mono">Ctrl+K</span>{' '}
            一键译成商务英语，译完还能改，不会替你发出去。看不懂对方的英文，浏览器右键「翻译成中文」。
          </p>
        </>
      ),
    },
    {
      id: 'basics-six',
      title: '六要素（问齐它就是这一局的及格线）',
      summary: '产品属性、数量、定制、地址条款、到货时间、其他需求。',
      body: () => (
        <>
          <p>产品属性 · 数量 · 定制需求 · 收货地址/条款 · 到货时间 · 其他需求</p>
          <p className="faint">
            产品属性要踩到底（款式/颜色/尺寸/参数/插头标准）；
            数量要<b>分属性</b>确认（3 色 1000 个，是每色 1000 还是合计）；地址和到货时间一起问。
          </p>
          <p>
            收尾：六要素问出 4 项以上、该报的价报了，就点「结束并复盘」。
            聊两三轮就结束会因证据不足不给分；拖满 20 轮算客户跑了。
          </p>
        </>
      ),
    },
    {
      id: 'basics-redlines',
      title: '四条红线',
      summary: '数量未知即报价、疑罪从有、空催、用中文作答。',
      body: () => (
        <ul>
          <li>
            <b style={{ color: 'var(--bad)' }}>① 数量未知即报价</b>　纯代码判定，无解释空间
          </li>
          <li>
            <b style={{ color: 'var(--bad)' }}>② 疑罪从有</b>　客户可疑就降低接待投入。
            可以多查、可以设边界，但不能因为怀疑就少服务
          </li>
          <li>
            <b style={{ color: 'var(--bad)' }}>③ 空催</b>　「你看到报价了吗」这种纯催促。
            每次跟进必须<b>有由头 + 带价值</b>
          </li>
          <li>
            <b style={{ color: 'var(--bad)' }}>④ 用中文作答</b>　客户是海外买家，他读不懂 ——
            发出去这一轮就白费了。先写中文没问题，<b>按 Ctrl+K 译成英文再发</b>，译完还能自己改
          </li>
        </ul>
      ),
    },
    {
      id: 'basics-quote-format',
      title: '报价格式（按总额分档）',
      summary: '<100 纯文字，100–300 要截图，>300 报价表加截图。',
      body: () => (
        <ul>
          <li>&lt; USD 100　纯文字就行</li>
          <li>USD 100–300　<b>至少要截图</b></li>
          <li>&gt; USD 300　<b>报价表 + 截图</b>，这一档才值得做深度背调</li>
        </ul>
      ),
    },
    {
      id: 'basics-gotchas',
      title: '三个会让人以为系统坏了的设计',
      summary: '翻译不替你多问、译文不带称呼、证据不足不给分。',
      body: () => (
        <ul>
          <li>翻译<b>不会替你多问</b>一句 —— 多译一句就等于六要素凭空多个勾，所以被禁掉了</li>
          <li>译文<b>不带 Hi / Best regards</b>：这是聊天窗不是邮件，除非你自己写了</li>
          <li>
            报告写「<b>证据不足以给出精确局分</b>」不是故障：这局太短，样本不够就不给分
          </li>
        </ul>
      ),
    },
    {
      id: 'basics-weekly',
      title: '你的考试要求（周考）',
      summary: '每周至少 2 场，只记录，不影响询盘分配和任何权限。',
      only: 'WEEKLY',
      body: () => (
        <>
          <p>
            <b>每周至少 {W.examsPerWeek} 场</b>，一场 {W.sessionsPerExam} 局，
            合计 {W.sessionsPerWeek} 局出分。周一到周日算一周，每天最多考 1 场。
          </p>
          <ul>
            <li>考试从「考试闸门」进，模拟询盘里练的局不计入</li>
            <li>练习不限次数，也<b>不要求先练够几局</b>才能考</li>
            <li>中位数旁边那条 {W.medianScoreMin} 分是<b>参考线</b>，不是门槛</li>
            <li><b>周考只记录</b>，不影响询盘分配，也不动任何权限</li>
          </ul>
          <p className="faint">
            开考瞬间 {W.sessionsPerExam} 局全部生成好，可以关掉浏览器分次打、当天回来接着打；
            但不能重开一场，也<b>不能跨天</b>——当天没打完的，系统在{SETTLE_LOCAL_TIME}结算时
            自动作废，第二天点不动了，没打完的那几局补不回来。
          </p>
        </>
      ),
    },
    {
      id: 'basics-admission',
      title: '准入规则',
      summary: '每天练够 3 局解锁考试，最近 6 局中位数 ≥65 拿到分配权。',
      only: 'ADMISSION',
      body: () => (
        <>
          <p>
            <b>训练期</b>（还没有新询盘分配权）
          </p>
          <ul>
            <li>每天 ≥{C.dailyDrillMin} 局演习 → 解锁 1 场考试（{C.sessionsPerExam} 局）</li>
            <li>
              最近 {C.windowDays} 天 {C.windowSessions} 局局分中位数 ≥{C.medianScoreMin} → 次日获得分配权
            </li>
          </ul>
          <p>
            <b>在岗期</b>（已有新询盘分配权）
          </p>
          <ul>
            <li>每天 1 场考试，不要求演习局</li>
            <li>
              连续 {C.consecutiveFailsToSuspend} 天不达标 → 次日暂停分配新询盘，退回训练期
            </li>
            <li>
              <b>暂停只停「分配新询盘」，手上的客户不动</b>
            </li>
          </ul>
          <p>
            <b>判定标准</b>（最近 {C.windowDays} 个业务日，每天 {C.sessionsPerExam} 局，
            共 {C.windowSessions} 局）
          </p>
          <ul>
            <li>局分<b>中位数</b> ≥ {C.medianScoreMin} —— 就这一条</li>
            <li>洞察力、复盘质量、红线照常评、照常写进报告，<b>但不参与判定</b></li>
            <li><b>缺考算不达标</b>（那一格空着就是不达标，连续天数照加）</li>
            <li>考了但系统没评出分（证据不足）→ 不构成判定，不算你的</li>
          </ul>
          <p className="help-callout">
            <b>
              判定用的是今天 + 前一个业务日这 {C.windowSessions} 局，不是今天这一场。
            </b>
            <br />
            一天发挥失常拉不垮，连着两天不行才会动资格。
            <br />
            <b>但缺考不一样</b>：那一天的格子会空着，不会拿更早的分数顶上 ——
            缺一天，这天和第二天都判不出达标。
          </p>
          <p className="faint">
            <b>考试本身</b>：每人每日 1 场，<b>开考瞬间 {C.sessionsPerExam} 局全部生成好</b> ——
            可以关掉浏览器分次打，当天回来接着打，不会丢；但<b>不能重开一场</b>，
            也<b>不能跨天</b>——当天没打完的，系统在{SETTLE_LOCAL_TIME}结算时自动作废，
            第二天点不动了；已出分的局照常计入窗口，<b>没打完的那几局补不回来</b>。
            考试局在「考试闸门」页进入，不在模拟询盘里。考试时六要素清单会隐藏。
            训练期那 {C.dailyDrillMin} 局演习是<b>行为量</b>门槛：只看你练了几局，不看打多少分。
          </p>
        </>
      ),
    },
  ],
};
