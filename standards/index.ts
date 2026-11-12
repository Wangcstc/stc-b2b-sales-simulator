/**
 * 标准层（standards）—— 柜子与抽屉共同遵守的方法论与契约。
 *
 * ★ 零依赖 ★ 这里只有数据和类型，不 import 项目里任何其他模块，也不读写文件系统。
 * 柜子、抽屉、题库工具包都可以依赖它；它不依赖任何人。`npm run check:boundaries` 强制检查。
 *
 * ★ 真源是 JSON ★ 考纲文档 `syllabus/README.md` 由 `npm run gen:syllabus-doc` 从 JSON 生成，不要手改。
 */
import syllabusJson from './syllabus/syllabus-v3.json';
import forcesJson from './forces.json';
import redlinesJson from './redlines.json';
import qualityJson from './quality-rules.json';
import poolJson from './pool-requirements.json';
import feedbackJson from './feedback-rules.json';
import templatesJson from './templates/raw-material-templates.json';

export type ForceKey = 'insight' | 'guidance' | 'solution' | 'trust' | 'closing' | 'negotiation' | 'stability';
export type SessionType = 'inquiry' | 'followup';
export type Difficulty = 'simple_with_distractors' | 'standard' | 'hard';
export type StageLetter = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';

export interface SyllabusType {
  /** 阶段字母 + 两位序号，如 A09 */
  code: string;
  /** 五字题型名，如「技术尽调型」 */
  name: string;
  stage: StageLetter;
  stage_name: string;
  session_type: SessionType;
  default_difficulty: Difficulty;
  /** 除默认档以外，这一型也可以出的难度档 */
  also_difficulties: Difficulty[];
  /** 能否进考试（风险识别型暂不进） */
  exam_eligible: boolean;
  /** 出题时要配背调包（买家背景资料，预埋一个错误结论考交叉验证） */
  needs_bg_package?: boolean;
  /** 主考力：必考 */
  key_forces: ForceKey[];
  /** 参与评分的力 */
  active_forces: ForceKey[];
  /** 不考的力（NA，不计分） */
  na_forces: ForceKey[];
  buyer_profile: string;
  tests: string;
  full_marks: string;
  typical_mistakes: string;
  material_signals: string;
  hidden_card_tips: string;
  /** 考纲 v1 的旧编码（P1…P32），只用于迁移旧题 */
  legacy_codes: string[];
  note?: string;
}

export interface Syllabus {
  syllabus_version: number;
  name: string;
  updated: string;
  naming_rule: string;
  code_rule: string;
  stages: { letter: StageLetter; name: string }[];
  session_types: Record<SessionType, string>;
  difficulties: Record<Difficulty, string>;
  exam_slots: { key: string; label: string; session_type: SessionType; difficulty: Difficulty | null }[];
  governance: string;
  types: SyllabusType[];
}

export interface Force {
  key: ForceKey;
  label: string;
  meaning: string;
}

export interface Redline {
  code: 'R1' | 'R2' | 'R3' | 'R4';
  label: string;
  judged_by: 'code' | 'model';
  effect: string;
}

export const SYLLABUS = syllabusJson as Syllabus;
export const SYLLABUS_VERSION = SYLLABUS.syllabus_version;
export const FORCES = forcesJson.forces as Force[];
export const REDLINES = redlinesJson.redlines as Redline[];

export interface QualityRules {
  hidden_cards: { min: number; max: number };
  unlock_patterns_per_card: { min: number };
  verify_should_per_card: { min: number };
  verify_should_not_per_card: { min: number };
  distractors: { max: number };
  init_state_range: { min: number; max: number };
}
/** 出题质量门槛：抽屉卡新题用，对已有题库只提醒 */
export const QUALITY_RULES = qualityJson as unknown as QualityRules;

export interface PoolRequirements {
  drill_min_questions: number;
  /** 每槽题数下限：低于它不许开考 */
  exam_slot_min_questions: number;
  /** 每槽题型数下限：低于它不许开考 */
  exam_slot_min_types: number;
  /** 每槽题型数目标：低于它教练台告警，不拦开考 */
  exam_slot_target_types: number;
  /** 单个题型在一个槽里的最大占比：超了告警 */
  exam_slot_max_type_share: number;
  /** 「不重题天数」低于它进教练台待办 */
  fresh_days_warn: number;
}
/** 题池开放门槛（默认值，阶段 4 实测后调整） */
export const POOL_REQUIREMENTS = poolJson as unknown as PoolRequirements;

/** 回流：实战表现异常的题出回炉建议的口径（阶段 6）。只出建议，主管拍板 */
export interface FeedbackRules {
  /** 至少攒够这么多局有分的局才判；拍过板的建议要再攒够这么多新局才再提 */
  min_sessions: number;
  /** 局分到这个数算「过了」（与准入的中位数门槛同一把尺） */
  pass_score: number;
  /** 通过率不低于它：太容易 */
  too_easy_pass_rate: number;
  /** 通过率不高于它：太难 */
  too_hard_pass_rate: number;
  /** 某张暗牌的解锁里，同一句话占比不低于它：被套话破解 */
  one_phrase_share: number;
  /** 判「被套话破解」至少要这么多次解锁 */
  one_phrase_min_unlocks: number;
  /** 挖出率低于它的暗牌算「常见失分点」 */
  rare_card_unlock_rate: number;
}
export const FEEDBACK_RULES = feedbackJson as unknown as FeedbackRules;

const byCode = new Map(SYLLABUS.types.map((t) => [t.code, t]));
const byLegacy = new Map(SYLLABUS.types.flatMap((t) => t.legacy_codes.map((c) => [c, t] as const)));

/** 按编码取题型；不存在返回 undefined */
export function syllabusType(code: string): SyllabusType | undefined {
  return byCode.get(code);
}

/** 考纲 v1 旧编码（P1…P32）→ 新题型 */
export function typeFromLegacyCode(legacyCode: string): SyllabusType | undefined {
  return byLegacy.get(legacyCode);
}

/** 原材料模板的列定义：Excel 模板按它生成，抽屉按它解析 */
export interface TemplateField {
  key: string;
  label: string;
  required?: boolean;
  type: 'text' | 'number' | 'list' | 'choice';
  choices?: string[];
}
export interface TemplateSheet {
  name: string;
  layout?: 'rows';
  columns?: TemplateField[];
  rows?: TemplateField[];
}
export interface TemplateFile {
  key: 'products' | 'company';
  file_name: string;
  sheets: TemplateSheet[];
}
export const RAW_MATERIAL_TEMPLATES = templatesJson as unknown as { template_version: string; files: TemplateFile[] };

export * from './prompts';
