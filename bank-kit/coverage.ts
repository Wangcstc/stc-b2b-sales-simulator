/**
 * 题库的考纲覆盖与计数。分槽口径与柜子的考试抽题一致（标准层 `exam_slots`）：
 *   跟进局 → 跟进槽；探需·标准 → 探需标准槽；探需·困难 → 探需困难槽；简单档不进考试。
 * 只有考试池里、且题型允许进考试的题，才计入考试槽位。
 */
import { POOL_REQUIREMENTS, SYLLABUS, syllabusType, type Difficulty } from '../standards/index';
import type { Counts, Coverage, Persona } from './types';

export function effectiveDifficulty(p: Persona): Difficulty {
  return p.difficulty ?? p.skeleton.difficulty;
}

export function examSlotOf(p: Persona): string | null {
  if (p.skeleton.session_type === 'followup') return 'FOLLOWUP';
  const d = effectiveDifficulty(p);
  if (d === 'standard') return 'STANDARD_INQUIRY';
  if (d === 'hard') return 'HARD_INQUIRY';
  return null;
}

function countsForExam(p: Persona): boolean {
  return p.active !== false && p.pool_type === 'admission_exam' && syllabusType(p.skeleton.type_code)?.exam_eligible === true;
}

export function computeCoverage(personas: Persona[]): Coverage {
  const live = personas.filter((p) => p.active !== false);
  const by_type: Coverage['by_type'] = {};
  for (const p of live) {
    const row = (by_type[p.skeleton.type_code] ??= { total: 0, drill: 0, admission_exam: 0 });
    row.total += 1;
    row[p.pool_type] += 1;
  }
  const slots: Coverage['slots'] = {};
  for (const slot of SYLLABUS.exam_slots) {
    const inSlot = live.filter((p) => countsForExam(p) && examSlotOf(p) === slot.key);
    slots[slot.key] = { types: new Set(inSlot.map((p) => p.skeleton.type_code)).size, questions: inSlot.length };
  }
  const missing_types = SYLLABUS.types.map((t) => t.code).filter((c) => !by_type[c]);
  // ★ 键按题型编码排序 ★ 计数要能逐字节比对，不能随题目的输入顺序变
  const sortedByType = Object.fromEntries(Object.entries(by_type).sort(([a], [b]) => a.localeCompare(b)));
  return { syllabus_version: SYLLABUS.syllabus_version, by_type: sortedByType, slots, missing_types };
}

/** 一个考试槽位离开考还差多少（给主管看的提示，不拦打包） */
export interface SlotReadiness {
  slot: string;
  label: string;
  questions: number;
  types: number;
  needQuestions: number;
  needTypes: number;
  ready: boolean;
  /** 能落进这个槽、题库里还一道都没有的题型——提示主管下次优先找这类聊天 */
  missingTypes: { code: string; name: string }[];
}

/** 一个题型能落进哪些考试槽位（按考纲的局型和允许的难度档） */
function slotsOfType(t: (typeof SYLLABUS.types)[number]): string[] {
  if (!t.exam_eligible) return [];
  const diffs = [t.default_difficulty, ...(t.also_difficulties ?? [])];
  return SYLLABUS.exam_slots
    .filter((s) => s.session_type === t.session_type && (s.difficulty === null || diffs.includes(s.difficulty)))
    .map((s) => s.key);
}

/**
 * 考试池按槽位看够不够开考。门槛和柜子开考用的是同一份（`standards/pool-requirements.json`）。
 * ★ 只是提示 ★ 演习不看这个，题再少也能练；考试凑齐前，抽屉照常打包、柜子照常装。
 */
export function examReadiness(
  personas: Persona[],
  need: { questions: number; types: number } = { questions: POOL_REQUIREMENTS.exam_slot_min_questions, types: POOL_REQUIREMENTS.exam_slot_min_types },
): SlotReadiness[] {
  const live = personas.filter(countsForExam);
  return SYLLABUS.exam_slots.map((slot) => {
    const inSlot = live.filter((p) => examSlotOf(p) === slot.key);
    const have = new Set(inSlot.map((p) => p.skeleton.type_code));
    const types = have.size;
    return {
      slot: slot.key,
      label: slot.label,
      questions: inSlot.length,
      types,
      needQuestions: need.questions,
      needTypes: need.types,
      ready: inSlot.length >= need.questions && types >= need.types,
      missingTypes: SYLLABUS.types.filter((t) => slotsOfType(t).includes(slot.key) && !have.has(t.code)).map((t) => ({ code: t.code, name: t.name })),
    };
  });
}

export function computeCounts(personas: Persona[], bgCount: number): Counts {
  const coverage = computeCoverage(personas);
  const live = personas.filter((p) => p.active !== false);
  return {
    total: personas.length,
    drill: live.filter((p) => p.pool_type === 'drill').length,
    admission_exam: live.filter((p) => p.pool_type === 'admission_exam').length,
    bg_packages: bgCount,
    by_type: Object.fromEntries(Object.entries(coverage.by_type).map(([k, v]) => [k, v.total])),
    by_slot: Object.fromEntries(Object.entries(coverage.slots).map(([k, v]) => [k, v.questions])),
  };
}
