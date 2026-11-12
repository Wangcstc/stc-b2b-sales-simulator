import Link from 'next/link';
import AppShell from '@/components/AppShell';
import { ADMISSION_CONFIG, SETTLE_LOCAL_TIME } from '@/lib/admission-v11';
import { WEEKLY_EXAM_CONFIG } from '@/lib/weekly-exam';
import { requireUser } from '@/lib/current-user';
import { examTrackOf } from '@/lib/exam-track';

export const dynamic = 'force-dynamic';

/**
 * 考前必读 —— 询盘接待准入考试的**全部规则**。
 *
 * ★ 2026-08-22 王老师定：规则只留这一页 ★
 * 在这之前，同一套规则同时挂在三个地方：考试闸门页的规则卡、闸门页的两个「?」气泡、
 * 还有这一页。讲的是同一件事，却要三处一起改——迟早对不上，界面上就会同时挂着两套门槛。
 * 现在分工是：
 *   · 这一页 = 规则（查一次记住的东西，写全、写清楚）
 *   · 考试闸门 = 状态屏（每天都要看的东西：今天能不能考、考到哪一步、最近 6 局判成什么样）
 *
 * ★ 唯一还需要同批改的是 Guide.tsx 的准入规则段 ★ 那是全站帮助里的摘要，口径必须一致。
 * ★ 数字一律从 ADMISSION_CONFIG 取 ★ 页面上再出现 65 / 3 / 6 的字面量都是复制，属于 bug。
 *
 * ★ 2026-08-24：这一页按考试轨分叉 ★
 * 「怎么考」和「四条红线」两条轨完全一样——同一个题池、同一套流程、同一把尺；
 * 其余（解锁、判定窗口、判定标准、判不过会怎样）全是**准入独有的**。
 * 把那几节原样端给正式业务员，等于告诉他「连着两天不行就停你的询盘」——
 * 那对他是假的，而他会照着它安排自己的节奏。
 */

/**
 * 规则小节：标题底下的那几条分点。分点样式见 globals.css 的 .rulebook
 *
 * ★ 2026-08-28 去掉外面那层 .card ★ 这一页是七个「章节标题 + 一块规则」，
 * 七个标题下面七个框——而标题自己就带竖条和下划线。全站同批去框，见 .table-wrap。
 */
function Rules({ children }: { children: React.ReactNode }) {
  return (
    <div className="rulebook" style={{ marginTop: 0 }}>
      <div className="grp">{children}</div>
    </div>
  );
}

export default async function ExamIntro() {
  const c = ADMISSION_CONFIG;
  const w = WEEKLY_EXAM_CONFIG;
  const user = await requireUser();
  /** 周考轨（正式业务员）不看准入那几节——那几条对他一条都不成立 */
  const weekly = examTrackOf(user) === 'WEEKLY';
  return (
    <AppShell current="/exam" narrow>
      <div className="page-head">
        <h1>考前必读</h1>
      </div>
      <p className="page-sub">
        {weekly ? (
          <>
            这一页是考试的<b>全部规则</b>：你每周要考几场、怎么考、分数记在哪。
            <br />
            今天能不能考、本周考到第几场，去<Link href="/exam">考试闸门</Link>看。
          </>
        ) : (
          <>
            这一页是考试的<b>全部规则</b>：怎么考、怎么解锁、怎么判、判不过会怎样。
            <br />
            今天能不能考、考到哪一步、最近 {c.windowSessions} 局判成什么样，去
            <Link href="/exam">考试闸门</Link>看。
          </>
        )}
      </p>

      {/* ── 正式业务员：一整节规则，代替下面那几节准入内容 ── */}
      {weekly && (
        <>
          <h2 className="section-title">一、你的训练要求</h2>
          <Rules>
            <div className="li">
              1. <b>每周至少 {w.examsPerWeek} 场</b>考试，一场 {w.sessionsPerExam} 局，
              合计 <b>{w.sessionsPerWeek} 局出分</b>。<b>周一到周日</b>算一周。
            </div>
            <div className="li">
              2. <b>每天最多 1 场</b>。一周五个工作日，考 {w.examsPerWeek} 场绰绰有余，
              什么时候考由你自己排。
            </div>
            <div className="li">
              3. <b>练习不限次数、不计入周考。</b>想练几局练几局，模拟询盘随时开——
              只有「考试闸门」开出来的局才进你的周考记录。
            </div>
            <div className="li">
              4. <b>不需要先练够几局才解锁考试。</b>那道闸是实习业务员训练期的，不套在你身上。
            </div>
          </Rules>

          <h2 className="section-title">二、分数记在哪</h2>
          <Rules>
            <div className="li">
              1. 每周一行，记<b>本周考了几场、出了几局分、本周考试局的中位数</b>。
              在<Link href="/train">训练台</Link>和<Link href="/exam">考试闸门</Link>都看得到。
            </div>
            <div className="li">
              2. 中位数旁边那条 <b>{w.medianScoreMin} 分</b>是<b>参考线</b>，
              和实习业务员用的是同一把尺、同一个题池，方便你知道自己在哪一档。
              <b>它不是门槛。</b>
            </div>
            <div className="li">
              3. ★ <b>周考只记录，不影响任何权限</b> ★ 不影响询盘分配、不动你的正式段位、
              不影响绩效判定。没考满只会在台账上记一笔，主管那边提一句。
            </div>
            <div className="li">
              4. 「进行中」＝这一周还没过完。周还没走完，系统不会说你没考满。
            </div>
          </Rules>

        </>
      )}

      {/* ── 准入轨专属：这六节对正式业务员一条都不成立 ── */}
      {!weekly && (
        <>
      <h2 className="section-title">一、这是什么考试</h2>
      <Rules>
        <div className="li">
          1. 它判的是<b>你能不能开始接新的真实询盘</b>——这是<b>上岗准入</b>，
          不是「合格业务员」评定，也不是转正。
        </div>
        <div className="li">
          2. 结果<b>不用于公开排名、晋升或淘汰</b>。达标时系统只显示一句「已获得询盘接待准入资格」。
        </div>
        <div className="li">
          3. 你只会处于两种状态之一：<b>训练期</b>（还没有新询盘分配权）、
          <b>在岗期</b>（有分配权）。资格<b>每天重算</b>，不是考过一次就一直有。
        </div>
      </Rules>

        </>
      )}

      {/* ── 两条轨共用：同一个题池、同一套开考流程、同一把尺 ── */}
      <h2 className="section-title">{weekly ? '三' : '二'}、怎么考</h2>
      <Rules>
        <div className="li">
          1. 每人<b>每天 1 场</b>，一场固定 {c.sessionsPerExam} 局：探需·标准、探需·困难、跟进各 1 局。
          考完就锁，同一天不能再考。
        </div>
        <div className="li">
          2. <b>开考瞬间 {c.sessionsPerExam} 局全部生成好</b>，可以关掉浏览器分次打、当天回来接着打，不会丢。
        </div>
        {/* ★ 2026-08-28 把这一条写实 ★（王老师定：规则一定要写进必读）
            原文只有「不要跨天——跨天那场作废」，是一句劝告：没说**谁**来作废、
            **什么时候**作废。于是 08-27 有一场没考完的，第二天还挂着「进行中」、
            三局照样点得动（见 lib/exam-expiry.ts 文件头）。规则写了但没人执行，
            人看到的就是「说作废其实没废」——那比不写更糟。
            现在把执行者和时刻一起写出来，业务员能拿它对账。 */}
        <div className="li">
          3. 但<b>不能重开一场</b>，也<b>不能跨天</b>。当天没打完的场次，
          <b>系统在{SETTLE_LOCAL_TIME}结算时自动作废</b>——第二天它就点不动了，
          不计你的考试次数。已经打完并出分的局照常{weekly ? '进本周记录' : '计入判定窗口'}，
          一局都不浪费；<b>没打完的那几局就没了，补不回来</b>，第二天要考得重新开一场。
        </div>
        <div className="li">
          4. 每局都要<b>正常结束、答完 5 个复盘问题并出分</b>，这一局才算数。
        </div>
        <div className="li">
          5. 考试时<b>六要素清单隐藏</b>，侧栏只保留产品参数与报价格式——该问什么，得你自己想。
        </div>
      </Rules>

      {!weekly && (
        <>
      <h2 className="section-title">三、怎么解锁今天这场</h2>
      <Rules>
        <div className="li">
          1. <b>训练期</b>：当日先练够 {c.dailyDrillMin} 局演习，才解锁当天的考试。
        </div>
        <div className="li">
          2. 这个门槛看的是<b>练够几局</b>，不看局分——但一局要聊满 {c.validDrillMinTurns} 轮、
          出了报告，<b>并且真问出了东西</b>（至少解开一张暗牌，或至少问到一项六要素），才算一局。
        </div>
        <div className="li">
          3. 明明练过进度却没涨，多半是有一局<b>光聊没问</b>——寒暄、自我介绍、发目录都不算问，
          回去把那一局真正想问的问出来。
        </div>
        <div className="li">
          4. <b>在岗期</b>：直接考，不要求演习局。
        </div>
      </Rules>

      <h2 className="section-title">四、判定窗口</h2>
      <Rules>
        <div className="li">
          1. 判定用的是<b>今天 + 前一个业务日这两天的 {c.windowSessions} 局</b>，
          <b>不是今天这一场</b>——一天发挥失常拉不垮，连着 {c.consecutiveFailsToSuspend} 天不行才会动你的资格。
        </div>
        <div className="li">
          2. <b>演习局（自由询盘）永远不进窗口</b>。
          演习只管解锁考试，打多少局都拉不动中位数。
        </div>
        <div className="li">
          3. 一天最多认 {c.sessionsPerExam} 局，取当天最早的 {c.sessionsPerExam} 局——
          考砸了再开一场，也挤不掉前面那几局。
        </div>
        <div className="li">
          4. <b>周末、放假、请假不进窗口，也不记你缺考。</b>判定只走工作日历，法定假期与调休由主管维护。
          那几天打的局<b>照常评分、照常写进报告</b>，该给的反馈一个不少，只是不参与准入判定。
        </div>
        <div className="li">
          5. 窗口<b>不会往前多捞</b>：那一天没考，那 {c.sessionsPerExam} 格就空着，
          不会拿更早的分数顶上。
        </div>
      </Rules>

      <h2 className="section-title">五、判定标准</h2>
      <Rules>
        <div className="li">
          1. 达标线<b>只有一条</b>：最近 {c.windowSessions} 局的
          <b>局分中位数 ≥ {c.medianScoreMin}</b>。
        </div>
        {/* ★ 必须写清楚哪些东西照评但不判 ★ 报告里照样有洞察力和红线，
            不写这一句，考生会以为报告里那个红线把自己判死了 */}
        <div className="li">
          2. 洞察力、复盘作答质量、红线<b>照常评、照常写进报告</b>，
          但 2026-08-21 起<b>不参与准入判定</b>——它们是给你看的反馈，不是判决。
        </div>
        <div className="li">
          3. <b>缺考算不达标，而且补不回来</b>——窗口只认当天考的局，今天多打几局也填不进昨天那几格。
          <b>缺考一天，这天和第二天都判不出达标</b>，要连着考满两天才重新出判定。
        </div>
        {/* ★ 这一段原来自相矛盾 ★（2026-08-22 修）引擎口径：preciseOk === false → passed = null，
            不记不达标（admission-v11.judgeWindow）。 */}
        <div className="li">
          4. 只有两种情况<b>不算你的</b>：今天还没考完（还能补）、考了但系统没评出分（证据不足）。
          证据不足是系统没评出来，不记你不达标；缺考是你没考，那几格补不回来。
        </div>
      </Rules>

      <h2 className="section-title">六、判过了 / 判不过，会怎样</h2>
      <Rules>
        <div className="li">
          1. <b>训练期达标</b> → 次日获得新询盘分配权，进入在岗期，主管开始给你分真实询盘。
        </div>
        <div className="li">
          2. <b>在岗期</b>每天 1 场，资格<b>每天重算</b>：最近 {c.windowSessions} 局仍达标就保留。
        </div>
        <div className="li">
          3. 连着 {c.consecutiveFailsToSuspend} 天不达标 → <b>次日起暂停给你分新询盘</b>，退回训练期。
          第一天不达标只会收到提醒，不动资格。
        </div>
        <div className="li">
          4. <b>暂停只停「分新询盘」这一项，手上已经在跟的客户仍然是你的</b>，跟进完全不受影响。
        </div>
        <div className="li">
          5. 回来的路：每天练够 {c.dailyDrillMin} 局解锁考试，
          最近 {c.windowSessions} 局中位数回到 {c.medianScoreMin}，<b>次日恢复</b>。
        </div>
      </Rules>

        </>
      )}

      {/* ── 两条轨共用：红线是聊天里的行为规范，跟走哪条轨无关 ── */}
      <h2 className="section-title">{weekly ? '四' : '七'}、四条红线</h2>
      <Rules>
        <div className="li">
          1. <b>R1 数量未确认即报价</b>：事实表还没确认数量就发报价。纯代码判定，直接生效。
        </div>
        <div className="li">
          2. <b>R2 疑罪从有</b>：仅因为客户可疑就明显降低接待投入。
          由模型判定，写进你的报告，客户兴趣会掉——但它不单独决定你的资格。
        </div>
        <div className="li">
          3. <b>R3 空催</b>：跟进既没有由头、没有新信息，也不带价值。同样由模型判定。
        </div>
        <div className="li">
          4. <b>R4 用中文作答</b>：直接把中文发给客户。纯代码判定（查有没有汉字），直接生效。
          <br />
          客户是海外买家，<b>他一个字都读不懂</b>——他只会回一句「看不懂，请用英文」，这一轮就白费了。
          先写中文完全没问题：<b>按 Ctrl+K 译成商务英语</b>，译完还能自己改，改完再发。
        </div>
        <div className="li">
          5. 红线<b>不进准入判定</b>，但它会扣客户的信任、耐心和兴趣，
          让客户提前离场——<b>局分自然就低了</b>。别把「不判」当成「没事」。
        </div>
      </Rules>

      <div className="card section-block" style={{ borderColor: 'var(--warn)' }}>
        <b className="small" style={{ color: 'var(--warn)' }}>一句话记住</b>
        {weekly ? (
          <p className="small" style={{ marginTop: 6, lineHeight: 1.9 }}>
            一周之内挑两天，各考一场 {w.sessionsPerExam} 局，本周的要求就完成了。
            <br />
            考不好也没关系——<b>这套东西不卡你的询盘、不动你的权限</b>，它存在的意义是让你有个地方练手、
            有一条自己能看见的成长曲线。
          </p>
        ) : (
          <p className="small" style={{ marginTop: 6, lineHeight: 1.9 }}>
            每天来考 1 场 {c.sessionsPerExam} 局，把最近 {c.windowSessions} 局的
            <b>局分中位数守在 {c.medianScoreMin} 以上</b>，分配权就一直在你手上。
            <br />
            缺考比考砸更亏——考砸还有分进窗口，缺考那几格是空的，谁也填不回来。
          </p>
        )}
      </div>

      {/* 收尾的动作行也走模块间距：读完整页之后那个按钮，
          和上一块贴太近会像是那一块的一部分 */}
      <div className="section-block">
        <Link href="/exam"><button className="primary">我已读完，返回考试闸门</button></Link>
      </div>
    </AppShell>
  );
}
