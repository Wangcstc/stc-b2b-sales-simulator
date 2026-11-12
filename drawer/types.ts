/**
 * 抽屉的数据形状。批次、素材、题目草稿、选择题卡都在这里定义。
 * 状态全部落盘（见 store.ts），任何一步中断后都能从断点续跑。
 */
import type { Persona } from '../bank-kit/index';
import type { Problem } from './qa/regex';

/** 一份素材（一段对话）的状态，见需求文档 6.2 */
export type ItemStatus =
  | 'received' // 收到原始导出件
  | 'redacted' // 已解析并脱敏
  | 'blocked' // 等主管确认（脱敏疑似漏网的人名）
  | 'triaged' // 已归型，等起草
  | 'skipped' // 不出题（写明原因）
  | 'drafted' // 母题已通过质检与校准
  | 'done' // 这份素材出的题全部处理完（进入确认队列或已弃用）
  | 'failed'; // 出错或重试用尽（写明原因）

/** 一道题（母题或变体）的状态 */
export type QuestionStatus = 'qa_failed' | 'awaiting_review' | 'accepted' | 'rejected' | 'revising';

export interface TriageResult {
  type_code: string;
  confidence: number;
  reason: string;
  /** 候选暗牌：素材里买家主动说出、业务员需要挖出来的信息 */
  candidates: { fact: string; message_index: number; quote: string }[];
  alt_types: string[];
  /** 归不进任何一型时的新增题型建议（由王老师拍板，抽屉不自动新增） */
  new_type_suggestion?: { name: string; reason: string } | null;
}

export interface Calibration {
  index: number | null;
  problems: Problem[];
  finishedAt?: number | null;
}

export interface Question {
  qid: string;
  kind: 'mother' | 'variant';
  /** 变体指向母题的 qid */
  parent?: string;
  persona: Persona;
  status: QuestionStatus;
  qa: Problem[];
  calibration?: Calibration;
  attempts: number;
  reviewIds: string[];
  /** 主管选「其他」写的修改意见，修订完清空 */
  revisionNote?: string;
  /** 主管要求修订时的上一版，修订完用来标出改了哪里，然后清空 */
  before?: Persona;
  /** 已经打进哪个题库版本、在里面叫什么编号（打包时撞号会顺延）。打过的题下次打包不再打 */
  packed?: { tag: string; id: string };
  /**
   * 回炉（阶段 6）：这一版是用来**替换**题库里编号为它的那道题的，不是新增。
   * 主管在回流页选「回炉」后设上，打包时顶替旧题、编号不变，装入成功后清掉。
   */
  replaces?: string;
  /** 背调包（考纲标了要配背调包的题型才有）；persona_id 跟题目编号走 */
  bg?: Record<string, unknown>;
}

export interface Item {
  id: string;
  file: string;
  status: ItemStatus;
  materialId: string;
  reason?: string;
  triage?: TriageResult;
  questions: Question[];
  /** 主管确认过的额外脱敏词 */
  extraTerms: string[];
  /** 投料时就是脱敏过的素材（redacted.json），没有原始件，不再走脱敏 */
  preRedacted?: boolean;
  /** 主管确认疑似漏网的词都是噪音，放行 */
  allowSuspects?: boolean;
  /** 变体工序已经跑过（有的变体没成形也不再重试，避免反复花钱） */
  variantsDone?: boolean;
  attempts: number;
}

export interface ChoiceOption {
  key: string;
  label: string;
  recommended?: boolean;
  /** 选它之后系统做什么（给人看的一句话） */
  effect?: string;
}

/** 选择题卡：3 个选项 + 「其他」，第一个是推荐项并写明理由（需求文档第八节） */
export interface ReviewCard {
  id: string;
  kind: 'use_question' | 'redact_suspect' | 'budget';
  itemId?: string;
  qid?: string;
  question: string;
  /** 推荐理由：来自质检或校准的实际结果 */
  reason: string;
  options: ChoiceOption[];
  /** 演习题可以「本页全部按推荐处理」，考试题必须逐道确认 */
  batchable: boolean;
  /** 主管要求修订后重新出的卡：这一版比上一版改了哪里 */
  changes?: string[];
  createdAt: string;
  answer?: { option: string; text?: string; at: string; by?: string };
}

export interface BatchConfig {
  /** 每道母题衍生几个考试变体 */
  variantsPerMother: number;
  /** 起草、修订最多重试几次 */
  maxAttempts: number;
  /** 出题门槛：买家发言至少几条 */
  minClientMessages: number;
  /** 归型置信度下限 */
  minConfidence: number;
  /** 这一批的预算（元）；0 ＝ 不设 */
  budgetCny: number;
  /** 脱敏后保留原始导出件（默认删） */
  keepRaw: boolean;
  /**
   * 本批的脱敏词表：自家公司名、品牌名、业务员昵称这些正则抓不到、只能显式列出的词（可写「原词=替换词」）。
   * 只用于脱敏，只存在工作区的批次设置里，永远不进题库包。
   */
  maskTerms?: string[];
  /**
   * 这一批最多开工几份素材（题库工坊「先加工 5 份看看效果」）。不写＝全部。
   * 已经开工的素材照常走完修订、变体；没开工的停在「已脱敏」，等主管放开。
   */
  processLimit?: number;
}

export interface Batch {
  id: string;
  createdAt: string;
  config: BatchConfig;
  status: 'open' | 'running' | 'paused' | 'stopped' | 'done';
  items: string[];
  usage: { calls: number; inputTokens: number; outputTokens: number; costCny: number };
  /** 公司信息表、产品表解析出来的结构化数据 */
  company?: Record<string, string>;
  products?: Record<string, unknown>[];
  log: { at: string; msg: string }[];
}

export const DEFAULT_CONFIG: BatchConfig = {
  variantsPerMother: 3,
  maxAttempts: 3,
  minClientMessages: 4,
  minConfidence: 0.5,
  budgetCny: 0,
  keepRaw: false,
};
