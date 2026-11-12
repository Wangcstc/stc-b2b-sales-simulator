import type { CSSProperties } from 'react';
import { ADMISSION_CONFIG } from './admission-v11';

/**
 * 「一人一天一行」那张表的列名与格子样式。
 *
 * ★ 为什么单独放一个纯 .ts 文件 ★（2026-08-21 修）
 * 这几个常量原来长在 components/TaskCells.tsx 里，而那是个 'use client' 文件。
 * 服务端组件从客户端文件 import 常量，拿到的不是对象本身，
 * 是一个客户端引用占位符——组件照样能渲染，普通常量取属性全是空。
 * 表现就是教练台的表头只剩第一格「业务员」，后面五个标题凭空消失。
 * 这个文件不带 'use client'，两边 import 的才是同一份真值。
 */

export const TH: CSSProperties = {
  textAlign: 'left',
  padding: '8px 12px',
  fontWeight: 400,
  whiteSpace: 'nowrap',
};

export const TD: CSSProperties = {
  padding: '8px 12px',
  borderTop: '1px solid var(--line)',
  whiteSpace: 'nowrap',
};

/** 表头文字。今日表与历史台账共用一套，改一处两边一起动 */
export const TASK_COLUMNS = {
  stage: '期别',
  drill: '演习',
  /**
   * ★ 写「2 天 6 局」不写「6 局」★（2026-08-21）只写 6 局，
   * 读的人会以为是「最近 6 局考试，不管哪天考的」——那正是修掉的那个 bug 的说法。
   * ★ 再加「考试」两个字 ★（2026-08-22 王老师问「这里是不是只算考试场」）
   * 光写「6 局」，旁边又有一列「演习」，很容易被读成「练手局也算进来了」。
   * 系统实际只捞 mode=ADMISSION_EXAM 的局（settlement.ts loadWindowSessions），
   * 自由询盘一局都不进这个窗口——表头就得把这件事说出来。
   */
  window: `最近 ${ADMISSION_CONFIG.windowDays} 天考试 ${ADMISSION_CONFIG.windowSessions} 局 · 中位数`,
  baseTask: '当日基本任务',
  /** 原来叫「四条」。2026-08-21 判定只剩局分一条，再叫四条就是错的 */
  gates: '判定',
  gap: '差在哪',
} as const;

/* ────────────────── 6 个格子的符号规范 ────────────────── */

/**
 * ★ 格子符号规范：一形一义，一色一动作 ★（2026-08-24 王老师定）
 *
 * 6 个格子只回答一个问题：「这一局考了吗、得了多少分」。答案有五种，
 * **每种意思只有一个符号，每种颜色只对应一个「该催谁」**：
 *
 * | 画什么 | 读作 | 颜色 | 主管要做的 |
 * |---|---|---|---|
 * | `68` | 考了，68 分 | 当天深黑加粗 / 前一天灰 | 不用动 |
 * | `?`  | 考了，系统没评出分 | `--muted`（看得见的灰） | **找开发**，不是找人 |
 * | `·`  | 还轮不到他 | `--faint`（最淡） | 什么都不用做 |
 * | `锁` | 那天没资格考 | `--warn` 橙 | 催他去**练** |
 * | `✗`  | 有资格却没来考 | `--bad` 红 | 催他去**考** |
 *
 * ★ 这次改掉的是什么 ★
 * ① **`—` 原来有两个意思**：「考了但系统没评出分」和「那天他还没入职」都画 `—`，
 *    而且在「前一天」那三格里两者的颜色**完全一样**（都是 `--faint`）——
 *    一个要去找开发，一个谁都不用管，却长得一模一样。
 *    现在「没评出分」改画 `?`（系统没答上来，语义正好），`—` 从此不再出现在格子里。
 * ② **「入职前」并进 `·`**：它和「今天还没考到」要做的事都是「什么都不用做」，
 *    分成两个符号，是把开发关心的区别摆到主管脸上。到底是哪一种，
 *    格子后面的小字和最右边「差在哪」用文字说——**那两句话现在必须能同时出现**，
 *    新人第一天恰好两者都有。
 *
 * ★ 加第六个符号之前先问一句 ★ 新符号必须对应一个**新的动作**。
 * 两种状态如果要催的是同一个人、做的是同一件事，就该共用一个符号——
 * 符号的数量应该等于「主管可能要做的事」的数量，不等于「系统内部有几种状态」。
 *
 * ★ 改了这里，要一起改的两处 ★
 *   · `components/CoachBoard.tsx` 的 Help 第 2 条（图例摆给主管看的那份）
 *   · `docs/机制规则/考核运行机制.md` §四
 */
export const SCORE_MARK = Symbol('score');

export interface SlotMark {
  /** SCORE_MARK 表示「画那个分数」，其余是要画的字符 */
  mark: string | typeof SCORE_MARK;
  color: string;
  bold: boolean;
  /** 鼠标悬停那句话。必须说清「这不是什么」和「该催谁」 */
  why: string;
}

/**
 * @param open 这一格属于「今天」，而今天还没考完——他下午还能去考。
 *             ★ 它优先于 locked ★ 今天演习才 1/3 局，现在就判「未解锁」是提前定性。
 */
export function markOf(
  cell: { missing: boolean; score: number | null; beforeHire: boolean; locked: boolean },
  open: boolean,
): SlotMark {
  if (!cell.missing) {
    return cell.score === null
      ? {
          mark: '?',
          color: 'var(--muted)',
          bold: false,
          why: '考了，但证据不足、系统没评出分——不是他的问题，也不记他不达标；要找的是开发',
        }
      : { mark: SCORE_MARK, color: 'var(--faint)', bold: false, why: '这一局的局分' };
  }
  // 「还轮不到他」两种：今天还没考到（下午还能补）／那天他还没入职。都是什么都不用做
  if (open) return { mark: '·', color: 'var(--faint)', bold: false, why: '今天这一局还没考到' };
  if (cell.beforeHire) return { mark: '·', color: 'var(--faint)', bold: false, why: '这天他还没进来——不是缺考' };
  if (cell.locked)
    return {
      mark: '锁',
      color: 'var(--warn)',
      bold: true,
      why: '当日演习没练够，考试没解锁——不是缺考；要催的是演习，不是考试',
    };
  return { mark: '✗', color: 'var(--bad)', bold: true, why: '缺考，这一格补不回来——要催的是考试' };
}
