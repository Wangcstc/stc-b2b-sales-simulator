/**
 * 题库工具包（bank-kit）—— 题库包的读、写、校验、覆盖统计、导出剥注。
 *
 * ★ 只依赖标准层 ★ 不认识柜子的数据库，也不知道题是怎么来的。
 * 抽屉用它写题库包，柜子用它读和校验题库包；两边之间唯一的数据契约就是题库包。
 * 外部只能从这个文件 import，不许直接引用 bank-kit 内部文件（`check:boundaries` 检查）。
 */
export * from './types';
export { computeCounts, computeCoverage, effectiveDifficulty, examReadiness, examSlotOf, type SlotReadiness } from './coverage';
export { contentHash, listBankFiles, readBank, sha256, writeBank, type WriteBankInput } from './io';
export { stripAnswers, stripNotes } from './strip';
export { lintPersona, validateBank, validateBgPackage, validatePersona, type Finding, type ValidationResult } from './validate';
export { canonicalCountry, countryCode, migrateLegacy, normalizeProduct, type MigrationReport, type NormalizedProduct } from './legacy';
