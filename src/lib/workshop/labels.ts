/**
 * 题库工坊界面上的中文说法。纯数据，界面和测试共用。
 * ★ 状态码不改，只翻译 ★ 抽屉的状态码是落盘格式，改了旧批次就读不懂了。
 */
import type { ItemStatus, QuestionStatus } from '../../../drawer/index';

export const ITEM_STATUS: Record<ItemStatus, { label: string; tone: '' | 'ok' | 'warn' | 'bad' | 'accent' }> = {
  received: { label: '已收到，等脱敏', tone: '' },
  redacted: { label: '已脱敏，等开工', tone: '' },
  blocked: { label: '等你确认脱敏', tone: 'warn' },
  triaged: { label: '已归型，等起草', tone: 'accent' },
  skipped: { label: '不出题', tone: '' },
  drafted: { label: '已出题', tone: 'accent' },
  done: { label: '处理完了', tone: 'ok' },
  failed: { label: '出错了', tone: 'bad' },
};

export const QUESTION_STATUS: Record<QuestionStatus, { label: string; tone: '' | 'ok' | 'warn' | 'bad' | 'accent' }> = {
  awaiting_review: { label: '等你确认', tone: 'warn' },
  accepted: { label: '已采用', tone: 'ok' },
  rejected: { label: '已弃用', tone: '' },
  revising: { label: '修订中', tone: 'accent' },
  qa_failed: { label: '没过质检', tone: 'bad' },
};

export const BATCH_STATUS: Record<string, string> = {
  open: '可以继续',
  running: '加工中',
  paused: '暂停（等你确认预算）',
  stopped: '已停止',
  done: '已完成',
};

export const DIFFICULTY_LABEL: Record<string, string> = {
  simple_with_distractors: '简单',
  standard: '标准',
  hard: '困难',
};

export const POOL_LABEL: Record<string, string> = { drill: '演习', admission_exam: '考试' };

/** 0.36 → 「约 0.4 元」；不到 1 毛的写「不到 0.1 元」 */
export function yuan(n: number): string {
  if (n <= 0) return '0 元';
  if (n < 0.1) return '不到 0.1 元';
  return `约 ${n < 10 ? n.toFixed(1) : Math.round(n)} 元`;
}
