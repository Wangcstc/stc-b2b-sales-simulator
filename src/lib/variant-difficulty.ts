/**
 * 「这一份变体是哪个档位」——**全站唯一一处解析口径**（2026-08-28 第三批）
 *
 * ★ 难度从骨架下沉到变体之后，多了一个「读哪一个」的问题 ★
 * `PersonaVariant.difficulty` 为 null 时跟骨架走，非 null 时覆盖骨架。
 * 这个判断本身只有一行，但它散布在**至少七处**读点（首页派单、题库分组、
 * 考试槽位、训练任务、有效局的非简单局计数、台账导出、教练台题库块）。
 * 一行逻辑抄七遍的下场，这个仓库已经吃过两次：
 *   · 中位数抄了两份，空数组行为不同，一份会静默出 NaN；
 *   · 槽位分档抄了两份，教练台说「够了」、开考说「不够」。
 * 所以先立这个文件，再改读点。**任何地方再出现 `?? persona.difficulty` 都是复制。**
 *
 * ★ 这个模块没有依赖 ★ 不 import 引擎、不 import prisma、不 import 任何东西。
 * 它是纯粹的字段解析，前端组件和服务端取数都能直接用。
 */

/** 读得出档位所需的最小形状。**不吃 Prisma 类型**，理由同 `inquiry-pool.PoolItemShape` */
export interface DifficultyBearing {
  /** 变体级覆盖。null / undefined ＝ 跟骨架走 */
  difficulty?: string | null;
  persona: { difficulty: string };
}

/**
 * 解析这一份变体真正生效的档位。
 *
 * @example
 *   variantDifficulty({ difficulty: null, persona: { difficulty: 'standard' } })  // 'standard'
 *   variantDifficulty({ difficulty: 'hard', persona: { difficulty: 'standard' } }) // 'hard'
 */
export function variantDifficulty(item: DifficultyBearing): string {
  const own = item.difficulty?.trim();
  return own ? own : item.persona.difficulty;
}

/**
 * 这一份是不是**声明了覆盖**（而不是跟着骨架走）。
 *
 * 界面上要把这件事标出来：一个「困难」的变体，它的考点默认是标准档还是本来就是困难档，
 * 对审题的人是两回事——前者是有人特意把它做难了，后者只是照骨架来。
 */
export function hasDifficultyOverride(item: DifficultyBearing): boolean {
  const own = item.difficulty?.trim();
  return Boolean(own && own !== item.persona.difficulty);
}
