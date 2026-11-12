/**
 * 机制难度指数 —— 把「这一局到底有多难」变成一个可回归的数（2026-08-28，第三批）
 *
 * ★ 为什么必须先有这个数，才谈得上「难度下沉到变体」★
 * 在这之前，`difficulty` 是**贴在骨架上的一个标签**，跟任何可度量的量都没有对应关系。
 * 把 146 份人设按标签分组取中位数，得到的是：
 *
 *   简单档：暗牌 7 张、干扰项 5 条、开局耐心 60
 *   标准档：暗牌 5 张、干扰项 2 条、开局耐心 90
 *   困难档：暗牌 7 张、干扰项 3 条、开局耐心 65
 *
 * **简单档在三项机制参数上没有一项比困难档简单。** 这不是错——32 个考点靠人工定标签
 * 完全够用，标签反映的是「这个考点认知上难不难」。但一旦允许客户自助生成变体
 * （产品化的前提），没有任何东西能判断他生成的那道题到底是标准还是困难，
 * 标签会立刻失去意义。所以先定义「难度是什么」，再谈把它下沉。
 *
 * ★ 它量的是机制难度，不是认知难度 ★ 两者不是一回事，也不该混：
 *   · 机制难度＝跑通这一局要花多少轮、耗掉多少容错、卡不卡得住。**这个能测。**
 *   · 认知难度＝这个考点本身难不难想明白。**这个测不了，只能人判。**
 * 骨架的 `difficulty` 继续承担认知难度（考点默认档），变体的 `difficulty` 承担机制难度。
 * 这个函数只回答后者。
 *
 * ★ 输入全部来自 autoplay 的那一遍模拟 ★ 不新增任何跑局成本：
 * 那个脚本本来就在用「设计者自己写的标准问法」把整局打一遍，
 * 打通用了几轮、结束时剩多少耐心、六要素收齐没有，三个数它一直在算，只是算完就扔了。
 */

/** autoplay 跑完一局之后能拿到的全部事实。**没有一项需要额外跑局** */
export interface MechanicalProbe {
  /** 开局耐心（人设的 `init_state.patience`） */
  initialPatience: number;
  /** 「六要素收齐 + 暗牌全开」用了第几轮。null ＝ 20 轮打满仍没干完 */
  finishedAt: number | null;
  /** 干完活（或掉出去）那一刻的剩余耐心 */
  patienceLeft: number;
  /** 好新人规规矩矩打，活没干完就被判离场。非 null ＝ 这一局对新人是死局 */
  died: string | null;
  /** 收齐的六要素项数（含 preset） */
  collectedElements: number;
  /** 暗牌张数 */
  cardCount: number;
  /** `requires` 依赖链的最长深度。0 ＝ 所有牌都是平的，问到就给 */
  maxRequireDepth: number;
  /** 需要 topic + framing 两组都命中才解锁的牌数（裸问不给的那种） */
  dualGateCards: number;
  /** 干扰项条数 */
  distractorCount: number;
}

/** 一局最多 20 轮（引擎的 maxTurns）。分母写在这儿，别在算式里散着写字面量 */
const MAX_TURNS = 20;
const SIX = 6;

export interface DifficultyBreakdown {
  /** 0–100，越大越难 */
  index: number;
  /** 逐项贡献，界面与报告要能说清「这 72 分是怎么来的」 */
  parts: {
    /** 干完活花了多长（轮数占 20 轮的比例） */
    length: number;
    /** 耗掉了多少容错（耐心消耗占开局耐心的比例） */
    burn: number;
    /** 卡住程度：六要素没收齐、或者干脆打不通 */
    blocked: number;
    /** 结构：暗牌张数、依赖链深度、双组解锁、干扰项 */
    structure: number;
  };
}

/**
 * 四项加权。**权重是拍出来的初值，不是真理**——与状态机那张规则表同一个性质：
 * 相对关系是定的（打不通最重、结构最轻），绝对值要靠全池分布回归着调。
 * 调它就改这四个数，别在调用处另算一套。
 */
const WEIGHTS = { length: 0.3, burn: 0.3, blocked: 0.25, structure: 0.15 } as const;

/** 夹到 0–1。所有分项都先归一化再加权，免得某一项量纲失控把总分带跑 */
function unit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * 算这一局的机制难度指数。
 *
 * ★ 打不通 = 满分那一档 ★ 好新人按标准问法都干不完活，说明这一局的机制卡死了；
 * 这种情况下轮数与耐心两项已经没有区分度（都跑到底了），所以直接把 blocked 拉满。
 * 注意这**不代表这局是好题**——`autoplay` 会另外报一条硬问题。
 * 难度指数只回答「有多难」，不回答「合不合理」。
 */
export function mechanicalDifficulty(probe: MechanicalProbe): DifficultyBreakdown {
  const finished = probe.finishedAt ?? MAX_TURNS;
  const length = unit(finished / MAX_TURNS);

  const initial = probe.initialPatience > 0 ? probe.initialPatience : 100;
  const burn = unit((initial - probe.patienceLeft) / initial);

  // 卡住程度：六要素每缺一项算一份，打不通或掉出去直接拉满
  const elementGap = unit((SIX - probe.collectedElements) / SIX);
  const blocked = probe.died !== null || probe.finishedAt === null ? 1 : elementGap;

  /**
   * 结构分：四个旋钮各占四分之一，各自的满档参照现有池子的上限定：
   * 暗牌 8 张、依赖链 3 层、双组解锁 6 张、干扰项 5 条。
   * 超过满档不再加分——再多一张暗牌不会让这局又难一倍。
   */
  const structure =
    (unit(probe.cardCount / 8) +
      unit(probe.maxRequireDepth / 3) +
      unit(probe.dualGateCards / 6) +
      unit(probe.distractorCount / 5)) /
    4;

  const index = Math.round(
    100 * (WEIGHTS.length * length + WEIGHTS.burn * burn + WEIGHTS.blocked * blocked + WEIGHTS.structure * structure),
  );

  return {
    index,
    parts: {
      length: Math.round(length * 100),
      burn: Math.round(burn * 100),
      blocked: Math.round(blocked * 100),
      structure: Math.round(structure * 100),
    },
  };
}

/* ═══════════════════ 这个指数**不是**档位标签 ═══════════════════ */

export type DifficultyBand = 'simple' | 'standard' | 'hard';

/** `simple_with_distractors` 也是简单档。与 `inquiry-pool.bucketOf` 同一条口径 */
export function bandOfLabel(label: string): DifficultyBand {
  if (label === 'hard') return 'hard';
  if (label === 'standard') return 'standard';
  return 'simple';
}

/**
 * ★ 原来这里有一组「指数 → 档位」的绝对分界（45 / 65），2026-08-28 当天就删了 ★
 *
 * 删的理由是实测数据，不是想法。全池 146 份跑下来：
 *
 *   声明「simple」  18 份 ｜ 实测 40–58 ｜ 中位 50   ← 机制上最重
 *   声明「standard」88 份 ｜ 实测 19–47 ｜ 中位 34   ← 机制上最轻
 *   声明「hard」    40 份 ｜ 实测 20–55 ｜ 中位 41
 *
 * **声明的「简单」档在机制上是最难的那一档，「标准」档最轻。** 按绝对分界去判，
 * 146 份里有 143 份「对不上」——那不是 143 个 bug，是这两把尺量的根本不是同一个东西：
 *
 *   · 标签量的是**认知难度**：这个考点本身难不难想明白。
 *     简单档（P1／P13／P17）考的是「先把话听清楚」，认知上确实最浅；
 *     可它们每份带 7 张暗牌、5 条干扰项，机制上一点都不轻。
 *   · 指数量的是**机制难度**：跑通这一局要几轮、耗掉多少容错、卡不卡得住。
 *
 * 硬把机制指数当成档位标签，等于用「跑完要多久」去判「这道题考什么」，
 * 而考试的三个槽位是按考点分的——一改档，槽位份数当场变，
 * 而考试池有「每槽 ≥14 份、≥4 个考点」的硬门槛，可能直接开不了考。
 *
 * ★ 所以这个指数只做两件事，都是相对的 ★
 *   ① 同一个考点派生两档时，验证两档**真的拉开了**（`MIN_BAND_GAP`）；
 *   ② 报告里给分布，供人判断——`npx tsx scripts/import/autoplay.ts --report`。
 * 它**不决定**任何变体的 `difficulty` 字段。要改档是人的事。
 */
export const INDEX_IS_NOT_A_LABEL = true;

/**
 * 同一个考点派生两档时，两档的指数至少要拉开这么多。
 *
 * ★ 不拉开就等于没分档 ★ 一个「困难版」如果只比标准版难 3 分，
 * 那它对业务员而言就是同一道题，而考试却按两个槽位在抽——
 * 困难槽名义上有题，实际考的是标准难度，而「困难局撑不撑得住」正是准入要判的东西。
 *
 * 12 这个数取自实测：全池里同一考点内部拉得开的有 P21(15)／P25(18)／P26(19)／
 * P27(13)／P30(13)，跨度都在 13 以上；拉不开的普遍在 10 以下。12 正好卡在中间。
 */
export const MIN_BAND_GAP = 12;
