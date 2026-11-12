/**
 * 「客户这一轮开不开口」判定内核的测试。
 *
 * ★ 这段逻辑的三种错法，没有一种会抛异常 ★
 *   · 该开窗没开 —— 报完价客户立刻回，补充说明的机会没了，这个机制等于没上线
 *   · 该关窗没关 —— 客户从此再也不开口，这一局卡死
 *   · 离场了还开窗 —— 人都要走了还按住他等你补充
 * 三种都只会让某一局悄悄变得不对劲，所以只能靠用例钉住。
 */

import { describe, expect, it } from 'vitest';
import {
  decideReplyWindow,
  decideTurnNudge,
  shouldFireDistractor,
  type AwaitingReply,
  type ReplyWindowInput,
  type TurnNudgeInput,
} from './turn-decide';

/** 生产里 SUPPLEMENT_TURNS = 1；用例默认跟它一致，需要时再显式改 */
const N = 1;

function inputOf(over: Partial<ReplyWindowInput> = {}): ReplyWindowInput {
  return {
    isFormAction: false,
    exitReason: null,
    pending: undefined,
    turn: 5,
    supplementTurns: N,
    ...over,
  };
}

const pendingAt = (turn: number, used: number): AwaitingReply => ({ turn, action: 'quote', used });

describe('① 开窗：动作类那一轮客户闭嘴', () => {
  it('报价那一轮开窗，used 从 0 起算', () => {
    const d = decideReplyWindow(inputOf({ isFormAction: true, action: 'quote', turn: 5 }));
    expect(d.branch).toBe('opening');
    expect(d.deferReply).toBe(true);
    expect(d.nextAwaiting).toEqual({ turn: 5, action: 'quote', used: 0 });
  });

  it('★ 发目录也开窗 ★ 判据是"是不是动作"，不是"是不是报价"（文档 3.3）', () => {
    const d = decideReplyWindow(inputOf({ isFormAction: true, action: 'catalog', turn: 3 }));
    expect(d.branch).toBe('opening');
    expect(d.nextAwaiting).toEqual({ turn: 3, action: 'catalog', used: 0 });
  });

  it('普通消息不开窗，客户照常回话', () => {
    const d = decideReplyWindow(inputOf({ isFormAction: false }));
    expect(d.deferReply).toBe(false);
    expect(d.branch).toBe('none');
    expect(d.nextAwaiting).toBeUndefined();
  });

  it('★ supplementTurns=0 等于关掉这个机制 ★ 回到"报完价客户立刻回"的老行为', () => {
    const d = decideReplyWindow(inputOf({ isFormAction: true, action: 'quote', supplementTurns: 0 }));
    expect(d.deferReply).toBe(false);
    expect(d.nextAwaiting).toBeUndefined();
  });
});

describe('② 续窗：补充机会还没用完', () => {
  it('开窗后的下一轮仍不出客户回复（N=2 时还剩一次）', () => {
    const d = decideReplyWindow(inputOf({ pending: pendingAt(5, 0), supplementTurns: 2 }));
    expect(d.branch).toBe('stillWaiting');
    expect(d.deferReply).toBe(true);
    expect(d.nextAwaiting).toEqual({ turn: 5, action: 'quote', used: 1 });
  });

  it('★ 续窗时 turn 与 action 保持不变 ★ 它记的是"哪个动作把客户按住了"，不是当前轮', () => {
    const d = decideReplyWindow(inputOf({ pending: pendingAt(5, 0), turn: 9, supplementTurns: 3 }));
    expect(d.nextAwaiting).toMatchObject({ turn: 5, action: 'quote' });
  });
});

describe('③ 关窗：补满了，客户这就开口', () => {
  it('N=1 时，开窗后的下一轮就该关窗出回复', () => {
    const d = decideReplyWindow(inputOf({ pending: pendingAt(5, 0), supplementTurns: 1 }));
    expect(d.branch).toBe('closing');
    expect(d.deferReply).toBe(false);
    expect(d.nextAwaiting).toBeUndefined();
  });

  it('用满 N 次后一定关窗，不会无限等下去', () => {
    const d = decideReplyWindow(inputOf({ pending: pendingAt(5, 2), supplementTurns: 3 }));
    expect(d.deferReply).toBe(false);
    expect(d.nextAwaiting).toBeUndefined();
  });
});

describe('★ 已经走到离场就一律不留窗口 ★ 人都要走了还按住他等你补充，那不是训练是荒诞', () => {
  it('动作类那一轮同时触发离场 → 不开窗', () => {
    const d = decideReplyWindow(inputOf({ isFormAction: true, action: 'quote', exitReason: 'patienceZero' }));
    expect(d.deferReply).toBe(false);
    expect(d.branch).toBe('none');
  });

  it('等待期间触发离场 → 立刻关窗', () => {
    const d = decideReplyWindow(
      inputOf({ pending: pendingAt(5, 0), exitReason: 'maxTurns', supplementTurns: 3 }),
    );
    expect(d.deferReply).toBe(false);
    expect(d.branch).toBe('closing');
    expect(d.nextAwaiting).toBeUndefined();
  });

  it('三种离场原因表现一致', () => {
    for (const exitReason of ['patienceZero', 'stagnant', 'maxTurns'] as const) {
      const d = decideReplyWindow(inputOf({ isFormAction: true, action: 'quote', exitReason }));
      expect(d.deferReply, exitReason).toBe(false);
    }
  });
});

describe('整条时间线走一遍（N=1，生产配置）', () => {
  it('报价 → 补一句 → 客户开口', () => {
    // 第 5 轮：报价，开窗
    const t5 = decideReplyWindow(inputOf({ isFormAction: true, action: 'quote', turn: 5, supplementTurns: 1 }));
    expect(t5.deferReply).toBe(true);

    // 第 6 轮：业务员补一句普通消息，N=1 已用满 → 关窗，客户回话
    const t6 = decideReplyWindow(inputOf({ turn: 6, pending: t5.nextAwaiting, supplementTurns: 1 }));
    expect(t6.deferReply).toBe(false);
    expect(t6.nextAwaiting).toBeUndefined();

    // 第 7 轮：回到常态
    const t7 = decideReplyWindow(inputOf({ turn: 7, pending: t6.nextAwaiting, supplementTurns: 1 }));
    expect(t7.deferReply).toBe(false);
    expect(t7.branch).toBe('none');
  });

  it('★ 窗口不会卡死 ★ 连跑 10 轮，客户一定在某一轮开口', () => {
    let pending: AwaitingReply | undefined = undefined;
    let opened = false;
    const replies: boolean[] = [];
    for (let turn = 1; turn <= 10; turn += 1) {
      const isFormAction = turn === 1; // 只在第一轮做一次动作
      const d = decideReplyWindow(inputOf({ isFormAction, action: 'quote', turn, pending, supplementTurns: 1 }));
      pending = d.nextAwaiting;
      replies.push(!d.deferReply);
      if (d.deferReply) opened = true;
    }
    expect(opened).toBe(true);
    expect(replies.filter(Boolean).length).toBeGreaterThan(0);
    // 第 1 轮闭嘴，其余都开口
    expect(replies[0]).toBe(false);
    expect(replies.slice(1).every(Boolean)).toBe(true);
  });

  it('纯函数：同样输入永远同样输出', () => {
    const input = inputOf({ pending: pendingAt(5, 0), supplementTurns: 2 });
    expect(decideReplyWindow(input)).toEqual(decideReplyWindow(input));
  });
});

describe('shouldFireDistractor：这一轮该不该抛干扰项', () => {
  it('常态下抛', () => {
    expect(shouldFireDistractor({ deferReply: false, repliedInChinese: false })).toBe(true);
  });

  it('★ 客户不开口就不抛 ★ 干扰项是"客户主动说的话"，他都不说话哪来的干扰项', () => {
    expect(shouldFireDistractor({ deferReply: true, repliedInChinese: false })).toBe(false);
  });

  it('★ 中文轮不抛 ★ 客户刚说完"我看不懂中文"又主动抛新问题，两句话是打架的', () => {
    expect(shouldFireDistractor({ deferReply: false, repliedInChinese: true })).toBe(false);
  });

  it('两个条件同时成立当然也不抛', () => {
    expect(shouldFireDistractor({ deferReply: true, repliedInChinese: true })).toBe(false);
  });
});

/**
 * ★ 轮内提示 ★（2026-08-28，王老师裁 D9 选项 A）
 *
 * 两条铁律靠这组用例钉住：
 *   ① **考试局一律没有**——演习和考试用的是同一批考点，考场上给提示等于送分；
 *   ② **只说状态，不给问法**——给了建议问法，练的时候看惯了，考试时反而更慌。
 * 两条错了都不会报错，只会安静地把演习变成开卷。
 */
describe('★ 轮内提示：只在演习局，只说状态 ★', () => {
  function nudgeInput(over: Partial<TurnNudgeInput> = {}): TurnNudgeInput {
    return {
      examMode: false,
      turn: 4,
      ended: false,
      unlockedThisTurn: 0,
      askedThisTurn: 0,
      collectedThisTurn: 0,
      formActionThisTurn: false,
      // 默认「上一轮也没进展」，这样每条用例测的都是它自己那一条判据
      previousTurnQuiet: true,
      ...over,
    };
  }

  it('连着两轮什么都没问出来 → 提示', () => {
    const text = decideTurnNudge(nudgeInput());
    expect(text).toContain('第 3、4 轮');
    expect(text).toContain('没问出新东西');
  });

  /**
   * ★ 一轮没进展不提示 ★（2026-08-28 当天按真实数据改的）
   * 第一版是「这一轮没进展就提示」。拿真人已经打完的 119 轮一量，
   * **52% 的轮次都符合「没问出新东西」**——提示会在一半以上的轮次弹出来。
   * 那不是提醒，是背景噪音；而噪音会被整个忽略，连带把真该看见的那次一起忽略。
   * 寒暄、确认客户刚说的话、客户答得含糊再问一次，都是正常的一轮。
   */
  it('★ 只有一轮没进展 → 不提示 ★ 否则一半的轮次都在弹，就成了噪音', () => {
    expect(decideTurnNudge(nudgeInput({ previousTurnQuiet: false }))).toBeNull();
  });

  it('★ 考试局永远没有提示 ★', () => {
    expect(decideTurnNudge(nudgeInput({ examMode: true }))).toBeNull();
    // 连"什么都没干"的考试局也不给——没有任何例外
    expect(decideTurnNudge(nudgeInput({ examMode: true, turn: 12 }))).toBeNull();
  });

  it('★ 提示里不许出现建议问法 ★ 只回答"有没有推进"，怎么改是报告的事', () => {
    const text = decideTurnNudge(nudgeInput())!;
    for (const banned of ['你应该', '试试', '建议', '可以问', '不妨']) {
      expect(text).not.toContain(banned);
    }
  });

  it('解开了暗牌 → 不提示', () => {
    expect(decideTurnNudge(nudgeInput({ unlockedThisTurn: 1 }))).toBeNull();
  });

  it('问到了六要素 → 不提示（问了客户没给也算问到）', () => {
    expect(decideTurnNudge(nudgeInput({ askedThisTurn: 1 }))).toBeNull();
  });

  it('客户这一轮答了新的六要素 → 不提示', () => {
    expect(decideTurnNudge(nudgeInput({ collectedThisTurn: 1 }))).toBeNull();
  });

  /** 那一轮他在交付，不是在问问题；系统还按住客户留一轮给他补充说明 */
  it('★ 报价/发目录那一轮不提示 ★ 否则是在骂他做对的事', () => {
    expect(decideTurnNudge(nudgeInput({ formActionThisTurn: true }))).toBeNull();
  });

  it('局已经结束 → 不提示', () => {
    expect(decideTurnNudge(nudgeInput({ ended: true }))).toBeNull();
  });

  it('还没聊过（第 0 轮）→ 不提示', () => {
    expect(decideTurnNudge(nudgeInput({ turn: 0 }))).toBeNull();
  });
});
