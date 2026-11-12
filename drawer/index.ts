/**
 * 抽屉（drawer）—— 把一家公司的原材料（聊天导出件 + 产品表 + 公司信息表）加工成题库包。
 *
 * ★ 外部只能从这个文件 import ★ 柜子和脚本不许直接引用抽屉内部文件（`check:boundaries` 检查）。
 * ★ 抽屉不认识柜子 ★ 不连柜子的数据库、不借柜子的模型客户端；产出只有一样东西：题库包目录。
 *
 * 十道工序见需求文档第 6 节；命令行入口是 `npm run drawer`（scripts/drawer.ts）。
 */

// 流水线
export {
  DRAWER_VERSION,
  answer,
  answerAllRecommended,
  createBatch,
  estimate,
  ingest,
  canRework,
  markPacked,
  pack,
  readItem,
  normalizePatterns,
  normalizePersona,
  redactPending,
  retry,
  rework,
  run,
  status,
  type BatchStatus,
  type IngestReport,
  type PackOptions,
  type PackReport,
  type RunOptions,
  type RunReport,
} from './pipeline';
export { Store, drawerRoot } from './store';
export { reviewSheet } from './sheet';
export { DEFAULT_CONFIG } from './types';
export type { Batch, BatchConfig, ChoiceOption, Item, ItemStatus, Question, QuestionStatus, ReviewCard, TriageResult } from './types';

// 模型与费用
export { OpenAiLlm, modelFor, type Llm, type LlmRequest, type LlmResponse, type Purpose } from './llm';
export { COST_BASIS, costOf, estimateBatch, peakMultiplier, type Estimate } from './cost';

// 原材料
export { MaterialError, catalogToProduct, readCompanySheet, readProductSheet, type CatalogEntry } from './materials';
export { parseChatFile, parseChatHtml, type ChatMessage, type RawChat } from './ingest/chat-parse';
export { createRedactor, type RedactAudit, type RedactResult, type RedactorOptions } from './ingest/chat-redact';

// 质检（命令行的单项检查也用这几样）
export { runGates, hardCount, type GateResult } from './qa/gate';
export { checkVariant, similarity, VARIANT_SIMILARITY_WARN } from './qa/variant';
export { checkBgPackage, type BgPackageShape } from './qa/bg';
export { checkRegex, cardsOf, INNOCENT_ASKS, INNOCENT_REPLIES, type Problem } from './qa/regex';
export { checkFidelity, type FidelityResult, type Material } from './qa/fidelity';
export { checkBuyerLanguage, checkPriceConsistency, type CatalogItem } from './qa/consistency';
export { runAutoplay, toAutoplayShape, type AutoplayPersona, type RunResult, type VerifyCase } from './qa/autoplay';
export { readMaskFile } from './mask';
