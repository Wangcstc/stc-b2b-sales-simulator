/**
 * Schema 守卫（技术方案 2.3 约束②）
 *
 * ★ 不因为"模型说它按 schema 输出了"就信 ★
 * DeepSeek 的 JSON Output 保证的是"输出是合法 JSON"，**不等于"符合 ExtractionSchema"**。
 * 所以代码侧无条件再跑一遍校验。
 *
 * 处理方式：**字段级丢弃**，不整条重试——对应「宁可漏判不可误判」。
 * 枚举越界/类型错的那个字段直接扔掉，其余字段照用。
 */

import type {
  Extraction,
  CustomerExtraction,
  SixElement,
  QuestionType,
  FollowupLevel,
} from '../../../engine/types';
import { SIX_ELEMENTS, QUESTION_TYPES, FOLLOWUP_LEVELS } from '../../../engine/types';

const BOOL_FIELDS = [
  'quantity_split_confirmed',
  'attribute_drilled',
  'asked_question',
  'has_altruistic_framing',
  'affirmed_customer',
  'emotional_expression',
  'is_empty_chase',
  'low_investment_on_suspicion',
  'contradiction_probe',
  'cited_bg_conclusion',
  'sent_catalog',
  // ★ 补齐 ★ 少了它，`firstEmailWithImage`（第一封开发信带图 → 进垃圾箱）
  // 这条规则从上线起就一次都没触发过——抽取端根本传不出这个字段。
  'email_with_attachment',
  'followup_has_hook',
] as const;

export function guardExtraction(
  raw: Record<string, unknown>,
  originalMessage: string,
): { extraction: Extraction; violations: string[] } {
  const violations: string[] = [];
  const out: Extraction = { asked_elements: [], asked_question: false };

  // asked_elements：枚举越界的项丢掉
  if (Array.isArray(raw.asked_elements)) {
    const bad = raw.asked_elements.filter((e) => !SIX_ELEMENTS.includes(e as SixElement));
    if (bad.length) violations.push(`asked_elements 越界：${JSON.stringify(bad)}，已丢弃`);
    out.asked_elements = raw.asked_elements.filter((e): e is SixElement => SIX_ELEMENTS.includes(e as SixElement));
  } else if (raw.asked_elements !== undefined) {
    violations.push('asked_elements 不是数组，整个丢弃');
  }

  for (const f of BOOL_FIELDS) {
    const v = raw[f];
    if (v === undefined) continue;
    if (typeof v === 'boolean') (out as unknown as Record<string, unknown>)[f] = v;
    else violations.push(`${f} 类型错（${typeof v}），已丢弃`);
  }

  if (raw.question_type !== undefined) {
    if (QUESTION_TYPES.includes(raw.question_type as QuestionType)) out.question_type = raw.question_type as QuestionType;
    else violations.push(`question_type 越界：${String(raw.question_type)}，已丢弃`);
  }

  if (raw.followup_level !== undefined) {
    const v = String(raw.followup_level);
    if (FOLLOWUP_LEVELS.includes(v as FollowupLevel)) out.followup_level = v as FollowupLevel;
    else violations.push(`followup_level 越界：${String(raw.followup_level)}，已丢弃`);
  }

  if (typeof raw.evidence_quote === 'string') out.evidence_quote = raw.evidence_quote;

  // ── asked_elements 的取证校验 ──
  //
  // ★ 2026-08-23 改成逐项 ★ 老口径是「整条消息共用一句 evidence_quote，
  // 引不出就把 asked_elements **整个数组**清空」。一条消息问了三项、模型只引了一句原话，
  // 三项全没——这正是业务员反馈的"我明明问了，它说我没问"里最冤的一类。
  // 现在每一项自带引文、逐项校验，引不出的只丢那一项。
  const body = normalize(originalMessage);
  const evidence = parseElementEvidence(raw.asked_element_evidence, body, violations);

  if (evidence !== null) {
    const proven = new Set(evidence.map((e) => e.element));
    const dropped = out.asked_elements.filter((e) => !proven.has(e));
    if (dropped.length) violations.push(`引不出原话，逐项丢弃：${JSON.stringify(dropped)}`);
    out.asked_elements = out.asked_elements.filter((e) => proven.has(e));
    out.asked_element_evidence = evidence.filter((e) => out.asked_elements.includes(e.element));
  } else {
    // 模型没给逐项引文（或整块不是数组）→ 退回老口径的整条 evidence_quote，
    // 历史 `Message.extraction` 回放走的也是这一支。
    const quote = (out.evidence_quote ?? '').trim();
    if (out.asked_elements.length > 0 && quote === '') {
      violations.push('无逐项引文且 evidence_quote 为空，asked_elements 全部丢弃（宁可漏判不可误判）');
      out.asked_elements = [];
    } else if (quote !== '' && !body.includes(normalize(quote))) {
      violations.push('evidence_quote 不是原文逐字片段，asked_elements 全部丢弃');
      out.asked_elements = [];
    }
  }

  return { extraction: out, violations };
}

/** 解析逐项引文。返回 null 表示模型压根没给这一块，调用方退回老口径 */
function parseElementEvidence(
  raw: unknown,
  normalizedBody: string,
  violations: string[],
): { element: SixElement; quote: string }[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) {
    violations.push('asked_element_evidence 不是数组，已忽略');
    return null;
  }

  const out: { element: SixElement; quote: string }[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const { element, quote } = item as { element?: unknown; quote?: unknown };
    if (!SIX_ELEMENTS.includes(element as SixElement)) continue;
    if (typeof quote !== 'string' || quote.trim() === '') continue;
    // 逐字回原文核对——模型很会编出"看起来很像"的引文
    if (!normalizedBody.includes(normalize(quote))) continue;
    out.push({ element: element as SixElement, quote: quote.trim() });
  }
  return out;
}

/**
 * 客户侧抽取的守卫（调用④）。纪律与业务员侧完全一致：
 * **引不出客户原话的那一项直接丢**。
 *
 * 这里比业务员侧更不能松——多标一项 `collected`，红线①（数量未确认即报价）
 * 就会漏判，而那是全系统唯一能作考试硬否决的判定。
 */
export function guardCustomerExtraction(
  raw: Record<string, unknown>,
  originalReply: string,
): CustomerExtraction {
  const body = normalize(originalReply);
  const answered = parseElementEvidence(raw.answered_elements, body, []) ?? [];

  // 同一项只留第一条
  const seen = new Set<SixElement>();
  const answered_elements = answered.filter((e) => !seen.has(e.element) && seen.add(e.element));

  const vague_elements = Array.isArray(raw.vague_elements)
    ? [...new Set(raw.vague_elements.filter((e): e is SixElement => SIX_ELEMENTS.includes(e as SixElement)))].filter(
        (e) => !seen.has(e),
      )
    : [];

  return { answered_elements, vague_elements };
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[\s　]+/g, '');
}
