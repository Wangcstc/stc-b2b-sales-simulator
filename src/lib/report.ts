/**
 * 单局报告组装（需求 9.7 七节结构）
 *
 * ★ 文案铁律（需求 1.3）★
 * 通篇禁止出现 L1–L5 或"能力段位"。演习分只叫【演习段位 D】。
 * 违反后果：造出一批"纸上谈兵的 L4"——七力漂亮、真实商机零推进。
 * 这里在组装完成后做一次断言拦截，`npm run lint:l-word` 再对源码扫一遍。
 */

import type { SessionFacts, SessionScore, ScoreOutput, Force } from '../../engine/types';
import { FORCE_LABEL, SIX_ELEMENTS, statusOf, DELIVERABLE_LABEL, quoteLines } from '../../engine/types';
import { DRILL_TIERS } from '../../engine/rules';
import type { ScoreLlmOutput } from './llm/score';

const L_WORD = /\bL[1-5]\b|能力段位/;

/** 报告文案里出现 L 等级表述就抛错——宁可不出报告，也不能出一份会误导人的报告 */
export function assertNoLGrade(text: string): void {
  const m = text.match(L_WORD);
  if (m) throw new Error(`报告文案出现禁用的等级表述「${m[0]}」（需求 1.3 铁律）`);
}

export interface ReportInput {
  drillId: string;
  turn: number;
  difficulty: string;
  /** ★ 局型必须传进来 ★ 这里过去没有这个字段，标题就把「探需局」写死了——
      9 个跟进局的报告全顶着「探需局」的抬头，而跟进局考的东西完全不同 */
  followup: boolean;
  exitReason: string | null;
  facts: SessionFacts;
  llm: ScoreLlmOutput;
  score: SessionScore;
  verified: ScoreOutput;
  coachQa?: { question: string; answer: string | null }[];
}

export function buildReport(i: ReportInput): string {
  const tierName = DRILL_TIERS.find((t) => t.tier === i.score.tier)?.name ?? '';
  const out: string[] = [];

  out.push(`# 演习报告：${i.drillId} · ${i.followup ? '跟进局' : '探需局'}`, '');

  // ── 一、你的答案盘点 ──
  out.push('## 一、你的答案盘点', '');
  // ★ 免责那句看的是「有没有答」，不是「有没有出过题」★（2026-08-22 修）
  // 整局跳过之后题目还在（length > 0），原判据会走进 else 分支，
  // 于是报告里摆着五个「（未作答）」，却**不再声明这份诊断是系统推断出来的**。
  const answered = (i.coachQa ?? []).filter((q) => Boolean(q.answer?.trim()));
  if (!i.coachQa || i.coachQa.length === 0 || answered.length === 0) {
    out.push('> 因未作答复盘问答，以下判断为系统推断。', '');
  }
  if (i.coachQa && i.coachQa.length > 0) {
    i.coachQa.forEach((q, n) => {
      out.push(`**Q${n + 1}** ${q.question}`, '', `**你的回答**：${q.answer ?? '（未作答）'}`, '');
    });
  }

  // ── 二、本局结论 ──
  out.push('## 二、本局结论', '');
  if (i.score.precise) {
    out.push(
      `| 项 | 值 |`,
      `|---|---|`,
      `| 演习段位 | **${i.score.tier}（${tierName}）** |`,
      `| 本局局分 | **${i.score.rawScore}** |`,
      /**
       * ★ 折算过就必须写出来 ★（2026-08-23）
       * 分数被难度系数动过而报告只显示结果，业务员会以为是评分乱跳。
       * 系数 1.0（绝大多数情况）这一行不出现，不给报告添噪音。
       */
      ...(i.score.difficultyFactor !== undefined &&
      i.score.difficultyFactor !== 1 &&
      i.score.baselineScore !== undefined
        ? [
            `| 难度系数 | ${i.score.difficultyFactor} —— 原始 ${i.score.baselineScore} 分按系数折算为 **${i.score.rawScore}** 分 |`,
          ]
        : []),
      `| 难度 | ${difficultyLabel(i.difficulty)} |`,
      `| 结局 | ${endingLabel(i.exitReason, i.facts)} |`,
      `| 总轮数 | ${i.turn} |`,
      `| 即时推进度 | ${i.llm.progress} |`,
      `| 复盘作答质量 | ${i.llm.answer_quality ?? '未作答'} |`,
      `| 红旗 | ${i.score.flags.length ? i.score.flags.map(flagLabel).join('、') : '无'} |`,
      '',
      '> 演习段位 D 与正式段位不同池子，不得用于晋升、淘汰或公开排名。',
      '',
    );
  } else {
    out.push(
      `**本局证据不足以给出精确局分。**`,
      '',
      `原因：${i.score.reason}`,
      '',
      '按 v6.0 硬规则，双门槛不达标时只给行为区间与训练动作，不给精确分数——',
      '样本不足时给一个精确到个位的分数，比不给分更有害，因为它看起来很客观。',
      '',
    );
  }

  // ── 三、客观事实表 ──
  out.push('## 三、客观事实表', '');
  const asked = SIX_ELEMENTS.filter(
    (k) => statusOf(i.facts.elements[k]) === 'collected' && i.facts.elements[k].source === 'asked',
  );
  const vol = SIX_ELEMENTS.filter((k) => i.facts.elements[k].source === 'volunteered');
  // ★ 单独列一行 ★ 「问了客户没给」和「压根没问」在报告里必须分开——
  // 混成一档，业务员就永远搞不清下一局该改什么（2026-08-19 反馈）。
  const pending = SIX_ELEMENTS.filter((k) => statusOf(i.facts.elements[k]) === 'asked_no_answer');
  out.push(
    `| 项 | 值 |`,
    `|---|---|`,
    `| 六要素·你问出来的 | **${asked.length}/6**　${asked.map(elLabel).join('、') || '无'} |`,
    `| 六要素·客户主动给的 | ${vol.length}　${vol.map(elLabel).join('、') || '无'}（不计你的功劳） |`,
    `| 六要素·你问了客户没给 | ${pending.length}　${
      pending
        .map((k) => `${elLabel(k)}（第${i.facts.elements[k].askedTurn}轮问的${i.facts.elements[k].vague ? '，客户答得含糊' : ''}）`)
        .join('、') || '无'
    } |`,
    // ★ 发了什么资料要能查（2026-08-19 反馈 #4）★ 「他到底发没发目录」以前只能翻聊天记录
    // 自己数，而聊天里的一句 "I'll send you the catalog" 看起来和真发了一模一样。
    `| 已投递资料 | ${
      (i.facts.deliverables ?? []).length
        ? (i.facts.deliverables ?? [])
            .map((d) => `${DELIVERABLE_LABEL[d.kind]}（第${d.turn}轮）`)
            .join('、')
        : '无'
    } |`,
    `| 属性踩到底 | ${i.facts.attributeDrilled ? '是' : '否'} |`,
    `| 数量分属性确认 | ${i.facts.quantitySplitConfirmed ? '是' : '否'} |`,
    `| 收齐轮数 | ${i.facts.turnsToCollectAll ?? '未收齐'} |`,
    `| 红线触发 | ${i.facts.redlines.length ? '**' + i.facts.redlines.join('、') + '**' : '无'} |`,
    `| 解锁暗牌 | ${i.facts.unlockedCards.map((c) => `${c.key}(第${c.turn}轮)`).join('、') || '无'} |`,
    '',
  );
  if (i.facts.quotes.length) {
    // ★ 逐个产品列出来（2026-08-19 反馈 #6）★ 只给一个总额的话，多产品报价在复盘里
    // 还是看不出哪个价对应哪个货——那正是这条反馈要解决的事。
    out.push('**报价记录**', '', '| 轮次 | 产品 | 单价 × 数量 | 小计 |', '|---|---|---|---|');
    for (const q of i.facts.quotes) {
      const lines = quoteLines(q);
      lines.forEach((l, n) => {
        out.push(
          `| ${n === 0 ? `第${q.turn}轮` : ''} | ${l.product || '（未写产品名）'} | USD ${l.unitPrice} × ${
            l.quantity
          } | USD ${(l.unitPrice * l.quantity).toFixed(2)} |`,
        );
      });
      if (q.freight) out.push(`| | 运费 | | USD ${q.freight.toFixed(2)} |`);
    }
    out.push('');

    out.push('| 轮次 | 总额 | 档位 | 格式 | 贸易术语 | 交期 | 数量 |', '|---|---|---|---|---|---|---|');
    for (const q of i.facts.quotes) {
      out.push(
        `| 第${q.turn}轮 | USD ${q.total.toFixed(2)} | ${q.tier} | ${q.formatCompliant ? '合规' : '**不合规**'} | ${
          q.tradeTerms || '未填'
        } | ${q.leadTimeDays ? `${q.leadTimeDays} 天` : '未填'} | ${
          q.quantityMismatch
            ? q.quantityConfirmed === false
              ? `**数量当时还没确认过就报了**`
              : `**与客户给的数量对不上**`
            : // ★ 「一致」得是真比过才敢说 ★（2026-08-24）这一局的暗牌没给出可对照的
              // 真实数量时，代码根本没资格下结论——写「一致」是另一种假话。
              q.quantityChecked === false
              ? '本局无对照数量'
              : '一致'
        } |`,
      );
    }
    out.push('');
  }

  // ── 四、七力评分与证据链 ──
  out.push('## 四、七力评分与证据链', '');
  for (const [force, item] of Object.entries(i.verified) as [Force, ScoreOutput[Force]][]) {
    if (!item) continue;
    out.push(`### ${FORCE_LABEL[force]}　${scoreLabel(item.score)}`, '');
    if (item.evidence.length) {
      out.push('**证据**：');
      for (const e of item.evidence) out.push(`- 第 ${e.turn} 轮：「${e.quote}」`);
    } else {
      out.push('**证据**：无（该维度未计入分母）');
    }
    out.push('', `**锚点**：${item.anchor}`, '', `**下一步**：${item.next_action}`, '');
  }

  // ── 五、逐段点评 ──
  out.push('## 五、逐段点评', '');
  for (const s of i.llm.segments) {
    out.push(
      `### 第 ${s.turn} 轮`,
      '',
      `> ${s.quote}`,
      '',
      `**问题**：${s.problem}`,
      '',
      `**王老师会怎么说**：${s.coach_comment}`,
      '',
      `**当时应该这么说**`,
      '',
      `- 中文：${s.better_reply_cn}`,
      `- English：${s.better_reply_en}`,
      '',
    );
  }

  // ── 六、掀开客户暗牌 ──
  out.push(
    '## 六、掀开客户暗牌',
    '',
    '> 这是演习相对真人带教最大的优势——真实客户永远不会告诉你他心里想什么。',
    '',
  );
  for (const u of i.llm.unveil) {
    out.push(
      `**${u.card}**：${u.what_it_was}`,
      '',
      `- ${u.missed_at_turn ? `你在第 ${u.missed_at_turn} 轮错过了它` : '本局未触及'}`,
      `- 当时问一句：${u.how_to_get_it}`,
      '',
    );
  }

  // ── 七、这一局只练一个动作 ──
  out.push('## 七、这一局只练一个动作', '', `**${i.llm.one_action}**`, '');

  const md = out.join('\n');
  assertNoLGrade(md);
  return md;
}

function difficultyLabel(d: string): string {
  const map: Record<string, string> = {
    simple: '简单',
    simple_with_distractors: '简单 + 干扰项',
    standard: '标准',
    hard: '困难',
  };
  return map[d] ?? d;
}

function elLabel(k: string): string {
  const map: Record<string, string> = {
    product_attr: '产品属性',
    quantity: '数量',
    customization: '定制需求',
    address: '地址/条款',
    delivery_time: '到货时间',
    other: '其他需求',
  };
  return map[k] ?? k;
}

function scoreLabel(s: ScoreOutput[Force] extends undefined ? never : NonNullable<ScoreOutput[Force]>['score']): string {
  if (s === 'NA') return '（本局不适用）';
  if (s === 'INSUFFICIENT') return '（证据不足，不计入分母）';
  return `${s} 分`;
}

function flagLabel(f: string): string {
  return f === 'high_skill_zero_progress' ? '🚩 高招式·零推进' : '🚩 高分·零认知';
}

function endingLabel(exitReason: string | null, facts: SessionFacts): string {
  if (exitReason === 'patienceZero' || exitReason === 'stagnant') return '客户 ghost（判负）';
  if (exitReason === 'maxTurns') return '超轮数，客户已选其他供应商';
  return facts.quotes.length ? '正常报价' : '未报价即结束';
}
