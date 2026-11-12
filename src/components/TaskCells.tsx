'use client';

import { ADMISSION_CONFIG, fmt, STAGE_LABEL } from '@/lib/admission-v11';
import { TD as DEFAULT_TD, markOf, SCORE_MARK } from '@/lib/task-columns';
import type { DailyTaskRow } from '@/lib/board';

/**
 * 「一人一天一行」那几个数据格。
 *
 * ★ 为什么单独拆一个文件 ★ 同一行要出现在两个地方：教练台顶上的「今日判定」
 * （服务端组件）和底下可筛选的历史台账（客户端组件）。列的口径必须是同一套——
 * 两边各写一遍，改了一边忘另一边，主管就会看到两张对不上的表。
 *
 * ★ 只 import 纯模块 ★ 这是 'use client' 文件，碰不得 lib/board.ts（它 import prisma）。
 * 期别中文名与阈值都从 lib/admission-v11.ts 拿——那个文件不碰数据库。
 * `type DailyTaskRow` 是纯类型 import，编译期就擦掉了，不会把 board.ts 拖进来。
 */

/**
 * 6 个格子里的缺口分**三**种，界面上必须分开画。
 *   · pending = 今天还没考到那一局。今天上午十点，今天那三格本来就是空的。
 *   · locked  = 那天训练期演习没练够，考试根本没解锁——**不是缺考，是没资格考**。
 *   · absent  = 真缺考。有资格考，那一天也过去了，就是没考。
 *
 * ★ 三种要做的动作完全不同 ★ pending 什么都不用做；locked 是催他去**练**；
 * absent 是催他去**考**。混成一个红叉，主管每天都会找错人。
 *
 * ★ 今天的 locked 不算 locked ★ 今天演习才 1/3 局，他下午再练两局照样能考，
 * 现在就判「未解锁」是提前给人定性——所以 pending 优先于 locked。
 */
function slotGaps(row: DailyTaskRow) {
  const open = row.isToday && row.examState !== '已考';
  // ★ 入职前的格子先摘出去 ★（2026-08-22）那天他还不是员工，
  // 既不该算缺考（催他去考）、也不该算未解锁（催他去练）——没人要催。
  const missing = row.windowScores.filter((cell) => cell.missing && !cell.beforeHire);
  const beforeHire = row.windowScores.filter((cell) => cell.missing && cell.beforeHire).length;
  const pending = missing.filter((cell) => cell.sameDay && open).length;
  const settled = missing.filter((cell) => !(cell.sameDay && open));
  const locked = settled.filter((cell) => cell.locked).length;
  return { absent: settled.length - locked, locked, pending, beforeHire };
}

/**
 * 合并后的「最近 2 天 6 局 · 中位数」一格（2026-08-21，王老师定）
 *
 * ★ 原来是两格 ★「当日三局 / 中位」摆左边，「滚动 6 局中位数」摆右边。
 * 毛病一：当日中位 66（看着过了 65）和滚动中位 61.5（其实没过）并排站着，
 * 一个绿一个红，而判定只认后面那个，一眼看过去容易读反。
 * 毛病二：今日那一行的滚动中位数**永远是空的**——结算只跑已经过去的业务日。
 *
 * 现在直接把判定窗口那几局摊开：**暗的是往前追的，亮的是这一天考的**，
 * 后面跟着的中位数就是这几个数算出来的。分从哪来、中位怎么得的，一行看完。
 */
function WindowScores({ row, compact }: { row: DailyTaskRow; compact: boolean }) {
  const need = ADMISSION_CONFIG.windowSessions;
  const { absent, locked, pending, beforeHire } = slotGaps(row);
  const shortSample = row.windowCount < need;
  const shortPrecise = !shortSample && row.windowPrecise < ADMISSION_CONFIG.preciseMin;
  // 样本不够时中位数不构成判定，就不该染成红或绿——那会被读成「他没达标」
  const decisive = !shortSample && !shortPrecise;

  return (
    <span className="task-score-window">
      {!compact && row.examState === '进行中' && <span style={{ color: 'var(--warn)' }}>进行中</span>}
      {/* ★ 已作废 ★（2026-08-22）那天开了考没打完，而那天已经过完了——
          那几局永远补不上。不说清楚，主管会以为还能催他「打完」。 */}
      {!compact && row.examState === '已作废' && (
        <span className="faint" title="那天开了考没打完，那一天已经过完，这几局补不回来">
          那场没打完
        </span>
      )}

      {row.windowScores.length === 0 ? (
        <span className="faint">{compact ? '中位 —' : '还没有考试局'}</span>
      ) : (
        <>
          {/* ★ 6 个格子按天排死 ★ 左三格是前一个业务日，右三格是这一天。
              没考的格子就空着画叉——不许拿更早的分数往里填，那正是
              「未考」和「局分✓」并排出现的病根。 */}
          <span style={{ display: 'inline-flex', gap: 7 }}>
            {row.windowScores.map((item, index) => {
              const open = item.sameDay && row.isToday && row.examState !== '已考';
              const cell = markOf(item, open);
              return (
                <span
                  key={`${item.day}-${index}`}
                  className="num"
                  style={{ color: cell.color, fontWeight: cell.bold ? 700 : 400 }}
                  title={compact ? undefined : `${item.day} · ${cell.why}`}
                >
                  {/* 当天考的那几格加粗、前一天的变灰——这一层只管「哪天考的」，
                      符号与颜色由 markOf 统一决定，别在这儿再补一套判断 */}
                  {cell.mark === SCORE_MARK ? (
                    <span style={item.sameDay ? { fontWeight: 700, color: 'var(--text)' } : undefined}>
                      {item.score}
                    </span>
                  ) : (
                    cell.mark
                  )}
                </span>
              );
            })}
          </span>

          {row.windowMedian === null ? (
            <span className="faint">中位 —</span>
          ) : (
            <b
              className="num"
              style={{
                color: decisive
                  ? row.windowMedian >= ADMISSION_CONFIG.medianScoreMin
                    ? 'var(--ok)'
                    : 'var(--bad)'
                  : 'var(--muted)',
              }}
            >
              {/* ★ 不满 6 局要写明是几局算的 ★ 光写「中位 70」，配着旁边三个红叉，
                  照样会被读成「他 70 分，过了」——而这个 70 只是他考过的那 3 局的中位数，
                  根本不构成判定。写成「3 局中位 70」，数字和它的份量就对上了。 */}
              {decisive ? '中位' : `${row.windowPrecise} 局中位`} {fmt(row.windowMedian)}
            </b>
          )}

          {/* ★ 样本不足要写在脸上 ★ 不写的话，新人第一天的「中位 51」
              和老手真掉下去的「中位 51」长得一模一样，可前者根本不构成判定。
              缺考和证据不足要分开说——一个是他没考，一个是系统没评出来。

              ★ 「入职前」和「今天还没考到」现在共用「·」，所以这几句话必须能同时出现 ★
              （2026-08-24）原来这两句互相排斥（beforeHire 那句要求 pending===0），
              而新人第一天恰好两者都有——格子里六个点，旁边却只说了其中一半。 */}
          {!compact && (
            <>
              {absent > 0 && (
                <span className="tiny" style={{ color: 'var(--bad)' }}>
                  缺考 {absent} 局
                </span>
              )}
              {locked > 0 && (
                <span className="tiny" style={{ color: 'var(--warn)' }}>
                  未解锁 {locked} 局
                </span>
              )}
              {pending > 0 && <span className="tiny faint">今天还没考完</span>}
              {beforeHire > 0 && <span className="tiny faint">{beforeHire} 局在他进来之前</span>}
              {shortPrecise && (
                <span className="tiny faint">
                  {row.windowCount - row.windowPrecise} 局没评出分（系统的问题，不记他的）
                </span>
              )}
            </>
          )}
        </>
      )}
    </span>
  );
}

/**
 * 「差在哪」一格（2026-08-21，原「准入判定」那块并进来的）
 *
 * ★ 光有勾叉不够 ★「判定」那一列只有 `局分✗`，差 0.5 分和差 20 分长得一模一样，
 * 可这两种情况处理方式完全不同：一个明天就能过，一个要重训。
 * 方案 9.7 定了铁律「未达标一律给距离」，`gate.text` 一直在算这句话，
 * 原来只有折叠起来的「准入判定」那块把它显示出来，点开才看得见。
 */
function GapCell({ row }: { row: DailyTaskRow }) {
  const failed = row.gates.filter((gate) => !gate.passed);

  const gaps = slotGaps(row);
  // ★ 有缺口就先说缺口 ★（2026-08-22）缺考现在判不达标，但要说的仍然是
  // 「哪天缺了几局」而不是「差几分」——分数不是他的问题，没来才是。
  if (row.passed === null || gaps.absent > 0 || gaps.locked > 0 || gaps.beforeHire > 0) {
    const { absent } = gaps;
    // ★ 入职前先说这一句 ★ 引擎的 sampleText 只会写「X 月 X 日 整天缺考」——
    // 它不知道那天他还不是员工。新人第一天看到自己「缺考」，是很糟的第一印象。
    if (gaps.beforeHire > 0 && absent === 0 && gaps.locked === 0) {
      return (
        <span className="faint">
          窗口里有 {gaps.beforeHire} 格在他<b style={{ color: 'var(--text)' }}>进来之前</b>
          ——不是缺考。判定要连着考满两天才出得来，新人第一天必然是这样。
        </span>
      );
    }
    // ★ 只有「未解锁」要在这儿自己说 ★ 其余几种（今天还没考完 / 哪天缺了几局 /
    // 证据不足）引擎的 sampleText 已经写对了——它拿到了 dayInProgress，
    // 知道今天还没过完。在这儿再写一遍，两处措辞迟早飘，而这句话同时出现在
    // 教练台和业务员自己的首页上，飘了就是两套说法。
    // 引擎唯一说不了的是演习：它只看考试局，不知道那天他压根没资格考。
    const lockedText =
      row.lockedDays.length > 0 ? (
        <>
          <span style={{ color: 'var(--warn)' }}>
            {row.lockedDays
              .map((item) => `${item.day} 演习 ${item.done}/${item.required} 局，考试没解锁`)
              .join('；')}
          </span>
          <span className="faint">—— 不是缺考，是当天没资格考；要催的是演习，不是考试。</span>
        </>
      ) : null;

    /**
     * ★ 缺考排在未解锁前面 ★（2026-08-24 修）
     * 原来是「有未解锁就先说未解锁」，于是一个昨天真缺考、今天还没练够的人，
     * 标题写的是「今天演习 0/3 没解锁」，而真正该催的「昨天缺了 1 局」被缩成末尾一句附注——
     * 同一行左边的「判定」列写的却是「缺考 · 不达标」，两列自己打自己。
     * 排序跟 `Verdict` 对齐：缺考 > 未解锁 > 其余。
     */
    if (absent > 0) {
      return (
        <span className="task-gap-detail">
          <span className="faint">{row.sampleText || '当晚尚未结算'}</span>{' '}
          {lockedText}
        </span>
      );
    }
    if (lockedText) return <span className="task-gap-detail">{lockedText}</span>;
    return <span className="faint">{row.sampleText || '当晚尚未结算'}</span>;
  }

  if (failed.length === 0) return <span style={{ color: 'var(--ok)' }}>达标</span>;
  return (
    <span style={{ display: 'inline-flex', gap: 12, flexWrap: 'wrap' }}>
      {failed.map((gate) => (
        <span key={gate.key} style={{ color: 'var(--bad)' }}>
          {gate.label}：{gate.text}
        </span>
      ))}
    </span>
  );
}

function CompactGapCell({ row }: { row: DailyTaskRow }) {
  const { absent, locked, pending, beforeHire } = slotGaps(row);
  const unscored = row.windowCount - row.windowPrecise;
  const lockedNotes = row.lockedDays.map(({ day }) => `${day.slice(5)} 未解锁`);
  const hasFailedGates = row.passed === false &&
    row.windowCount >= ADMISSION_CONFIG.windowSessions && row.windowPrecise >= ADMISSION_CONFIG.preciseMin;
  const failedGates = hasFailedGates ? row.gates.filter((gate) => !gate.passed) : [];
  const notes = [
    absent > 0 && `缺考 ${absent} 局`,
    ...lockedNotes,
    locked > 0 && lockedNotes.length === 0 && `未解锁 ${locked} 局`,
    row.examState === '已作废' && '考试已作废',
    row.examState === '进行中' && '考试中',
    row.examState !== '进行中' && pending > 0 && `待考 ${pending} 局`,
    unscored > 0 && `${unscored} 局未出分`,
    beforeHire > 0 && `入职前 ${beforeHire} 局`,
    ...failedGates.map((gate) => gate.key === 'score' && row.windowMedian !== null
      ? `局分差 ${fmt(ADMISSION_CONFIG.medianScoreMin - row.windowMedian)} 分`
      : `${gate.label} ${gate.text}`),
  ].filter(Boolean);

  if (notes.length > 0) return <span className="muted">{notes.join(' · ')}</span>;
  if (row.passed === true) return <span style={{ color: 'var(--ok)' }}>达标</span>;
  if (row.passed === false) return <span style={{ color: 'var(--bad)' }}>未达标</span>;
  return <span className="faint">—</span>;
}

/**
 * 判定那一格。
 *
 * ★ 缺考不画「局分✗」★（2026-08-22）缺考现在算不达标，但它不是「分数低」——
 * 画成局分✗，主管会去找他谈分数，其实该问的是「他为什么没来考」。
 * 未解锁也一样：那天他没资格考，要催的是演习。
 *
 * ★ 剩下两种仍然是「不判定」★ 今天还没考完（还能补）、考了但系统没评出分
 * （证据不足，不是他的错）——这两种不记不达标。
 */
function Verdict({ row }: { row: DailyTaskRow }) {
  const { absent, locked, pending, beforeHire } = slotGaps(row);
  if (absent > 0) return <span style={{ color: 'var(--bad)' }}>缺考 · 不达标</span>;
  if (locked > 0) return <span style={{ color: 'var(--warn)' }}>未解锁 · 不达标</span>;
  // ★ 入职前不画不达标 ★ 那几格他还不是员工，结算侧本来就不判这些日子
  if (beforeHire > 0 && row.passed === null) return <span className="faint">入职前 · 不判定</span>;
  if (row.passed === null) {
    if (pending > 0) return <span className="faint">今天未考完</span>;
    return <span className="faint">证据不足 · 不判定</span>;
  }
  return (
    <>
      {row.gates.map((gate) => (
        <span key={gate.key} style={{ color: gate.passed ? 'var(--ok)' : 'var(--bad)' }}>
          {gate.label}
          {gate.passed ? '✓' : '✗'}
        </span>
      ))}
    </>
  );
}

/** 期别 / 演习 / 最近 2 天 6 局 / 当日基本任务 / 判定 / 差在哪 —— 前面那格「谁」或「哪天」由调用方自己出 */
export function TaskCells({ row, td = DEFAULT_TD, compact = false }: {
  row: DailyTaskRow;
  td?: React.CSSProperties;
  compact?: boolean;
}) {
  // ★ 请假那天整行不判定 ★ 那天对他不是业务日：不要求演习、不要求考试、
  // 不出判定，这一天也不会在任何人的判定窗口里留下空格。
  // 和「缺考」必须一眼分得开——一个是批过的，一个是没来。
  if (row.onLeave) {
    return (
      <>
        <td style={td} className="small">
          <b>{STAGE_LABEL[row.stage]}</b>
        </td>
        {compact && <td style={td} colSpan={4} />}
        <td style={{ ...td, whiteSpace: 'normal' }} className="small" colSpan={compact ? 1 : 5}>
          <b style={{ color: 'var(--warn)' }}>请假</b>
          {row.onLeave.reason && <span style={{ marginLeft: 8 }}>{row.onLeave.reason}</span>}
          {!compact && (
            <span className="faint" style={{ marginLeft: 12 }}>
              这天对他不是业务日：不要求演习与考试，不判定，也不会在判定窗口里留下空格。
            </span>
          )}
        </td>
      </>
    );
  }
  const showTaskGap = !compact || row.drillDone < row.drillRequired || row.examState === '进行中';
  return (
    <>
      <td style={td} className="small">
        <b>{STAGE_LABEL[row.stage]}</b>
        {/* ★ 两个数字打架的时候，人要看得见在打架 ★（方案第二节）
            只写「在岗期」，过几周谁都不记得这是主管手动开的、而系统一直判他不过 */}
        {row.stageOverride && (
          <span className="tiny" style={{ color: 'var(--warn)' }}>
            （主管定的）
          </span>
        )}
        {row.recommendedStage && row.recommendedStage !== row.stage && (
          <div className="tiny" style={{ color: 'var(--warn)' }}>
            系统判定应为 {STAGE_LABEL[row.recommendedStage]}
          </div>
        )}
      </td>
      <td style={td} className="small">
        {row.drillRequired === 0 ? (
          <span className="faint">不要求</span>
        ) : (
          <span style={{ color: row.drillDone >= row.drillRequired ? 'var(--ok)' : 'var(--warn)' }}>
            {row.drillDone}/{row.drillRequired} 局
          </span>
        )}
      </td>
      <td style={td} className="small">
        <WindowScores row={row} compact={compact} />
      </td>
      <td style={td} className="small">
        {row.baseTaskDone ? (
          <span style={{ color: 'var(--ok)' }}>✓ 完成</span>
        ) : (
          showTaskGap ? <span style={{ color: 'var(--bad)' }}>✗ {row.baseTaskText}</span> : <span className="faint">—</span>
        )}
      </td>
      <td style={td} className="small">
        <span className="task-verdict">
          {/* ★ 缺考、未解锁、样本不足都不画勾叉 ★ 画成「局分✗ 洞察力✗」，
              和真的考砸了长得一模一样，主管会找错人。到底缺在哪天、还差几局，
              右边「差在哪」那格会说。 */}
          {!compact && <Verdict row={row} />}
          {row.consecutiveFails > 0 && <span style={{ color: 'var(--warn)' }}>连续 {row.consecutiveFails} 天</span>}
          {compact && row.consecutiveFails === 0 && <span className="faint">—</span>}
        </span>
      </td>
      <td style={{ ...td, whiteSpace: 'normal' }} className="small">
        {compact ? <CompactGapCell row={row} /> : <GapCell row={row} />}
      </td>
    </>
  );
}
