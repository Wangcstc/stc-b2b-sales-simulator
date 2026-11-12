/**
 * 变体级难度解析的测试（2026-08-28 第三批）。
 *
 * ★ 为什么这一行逻辑值得单独测 ★
 * 它只有一行（`variant.difficulty ?? persona.difficulty`），但它散在七处读点上：
 * 首页派单、题库分组、考试槽位、训练任务、有效局的非简单局计数、台账导出、教练台题库块。
 * 读错的后果全部是**静默的**：一份题被分进错误的槽位、一局简单局被算进段位、
 * 一个「困难版」在派单里当标准局发出去——没有一种会抛异常。
 *
 * 这个仓库已经为「同一行逻辑抄两遍」付过两次学费（中位数抄两份、槽位分档抄两份），
 * 所以这里先立唯一口径，再用用例把它钉住。
 */

import { describe, expect, it } from 'vitest';
import { hasDifficultyOverride, variantDifficulty } from './variant-difficulty';

describe('variantDifficulty：变体没声明就跟骨架走', () => {
  it('变体没有覆盖 → 用骨架的档位', () => {
    expect(variantDifficulty({ persona: { difficulty: 'standard' } })).toBe('standard');
    expect(variantDifficulty({ difficulty: null, persona: { difficulty: 'hard' } })).toBe('hard');
    expect(variantDifficulty({ difficulty: undefined, persona: { difficulty: 'simple_with_distractors' } })).toBe(
      'simple_with_distractors',
    );
  });

  it('变体声明了覆盖 → 以变体为准', () => {
    expect(variantDifficulty({ difficulty: 'hard', persona: { difficulty: 'standard' } })).toBe('hard');
  });

  /**
   * ★ 空字符串按「没声明」处理 ★
   * JSON 里写 `"difficulty": ""` 多半是手滑或者模板没填。
   * 当成一个合法档位会让这份题掉进「既不是简单也不是标准也不是困难」的缝里——
   * `examSlotOf` 会返回 null，于是它从考试池里静默消失，而没有任何东西会报错。
   */
  it('空字符串与纯空白视为没声明', () => {
    expect(variantDifficulty({ difficulty: '', persona: { difficulty: 'standard' } })).toBe('standard');
    expect(variantDifficulty({ difficulty: '   ', persona: { difficulty: 'standard' } })).toBe('standard');
  });
});

describe('hasDifficultyOverride：审题的人要看得出这是不是有人特意做难的', () => {
  it('没声明 → 不算覆盖', () => {
    expect(hasDifficultyOverride({ persona: { difficulty: 'standard' } })).toBe(false);
    expect(hasDifficultyOverride({ difficulty: null, persona: { difficulty: 'standard' } })).toBe(false);
  });

  it('声明了但和骨架一样 → 不算覆盖', () => {
    expect(hasDifficultyOverride({ difficulty: 'standard', persona: { difficulty: 'standard' } })).toBe(false);
  });

  it('声明了不同的档位 → 算覆盖', () => {
    expect(hasDifficultyOverride({ difficulty: 'hard', persona: { difficulty: 'standard' } })).toBe(true);
  });
});
