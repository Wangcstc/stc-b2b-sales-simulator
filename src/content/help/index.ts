import { BASICS_HELP } from './basics';
import { COACH_HELP } from './coach';
import { DRILL_HELP } from './drill';
import { INQUIRIES_HELP } from './inquiries';
import { REPORT_HELP } from './report';
import { TEAM_HELP } from './team';
import { TRAIN_HELP } from './train';
import { SUMMARY_MAX, type HelpPage, type HelpSection } from './types';

export type { HelpPage, HelpSection, HelpVars } from './types';
export { SUMMARY_MAX } from './types';

/**
 * 全站帮助内容的注册表
 *
 * ★ 顺序就是 /help 页面上的顺序 ★ 按「新人最先要用到的」排，
 * 不按字母、不按开发方便：新人必读 → 模拟询盘 → 对话页 → 报告 → 训练台 → 教练台 → 账号管理。
 */
export const HELP_PAGES: HelpPage[] = [
  BASICS_HELP,
  INQUIRIES_HELP,
  DRILL_HELP,
  REPORT_HELP,
  TRAIN_HELP,
  COACH_HELP,
  TEAM_HELP,
];

/**
 * 锚点 id = 页面 id + 小节 id。
 *
 * ★ 为什么不直接用小节 id ★ 「历史记录」「登录流水」这两节
 * 教练台和训练台都要用（见 shared.tsx），同一个小节会在两页各出现一次。
 * 用页面 id 兜一层，两处各有自己的锚点，DOM id 不会撞。
 */
export function anchorOf(pageId: string, sectionId: string): string {
  return `${pageId}--${sectionId}`;
}

export function findPage(pageId: string): HelpPage | undefined {
  return HELP_PAGES.find((p) => p.id === pageId);
}

/**
 * 按小节 id 找它所在的页。
 *
 * `preferPage` 传当前页 —— 共享小节在两页都有，优先返回用户正待着的那一页，
 * 否则会把在训练台点「?」的业务员导到教练台那一组去（他根本进不去）。
 */
export function findSection(
  sectionId: string,
  preferPage?: string,
): { page: HelpPage; section: HelpSection } | undefined {
  const ordered = preferPage
    ? [...HELP_PAGES].sort((a, b) => (a.id === preferPage ? -1 : b.id === preferPage ? 1 : 0))
    : HELP_PAGES;
  for (const page of ordered) {
    const section = page.sections.find((s) => s.id === sectionId);
    if (section) return { page, section };
  }
  return undefined;
}

/**
 * 开发期自检 —— 这一段是整套方案的守门人
 *
 * ★ 为什么要在代码里拦 ★
 * 「气泡只装一句话」是个约定，而约定会烂。半年后有人觉得
 * 「这条再补一句更清楚」，补着补着气泡里又是八条带滚动条的文档，
 * 这次重构就白做了。所以把它变成会报错的规则：
 *   · summary 超过 SUMMARY_MAX 字 → 报错，逼你把内容挪进 body
 *   · summary 里出现换行或分点编号 → 报错，那是文档不是一句话
 *   · 同一页里 id 撞了 → 报错，锚点会失效
 * 只在 development 跑，生产环境不付这个开销。
 */
function assertContent(): void {
  const problems: string[] = [];
  for (const page of HELP_PAGES) {
    const seen = new Set<string>();
    for (const s of page.sections) {
      if (seen.has(s.id)) problems.push(`[${page.id}] 小节 id 重复：${s.id}`);
      seen.add(s.id);
      if (s.summary.length > SUMMARY_MAX) {
        problems.push(
          `[${page.id}/${s.id}] summary ${s.summary.length} 字，超过 ${SUMMARY_MAX} —— 气泡装不下，把它挪进 body`,
        );
      }
      if (/\n|^\s*\d+[.、]/.test(s.summary)) {
        problems.push(`[${page.id}/${s.id}] summary 里有换行或分点编号 —— 气泡只装一句话`);
      }
    }
  }
  if (problems.length) {
    throw new Error(`帮助内容不合规：\n  ${problems.join('\n  ')}`);
  }
}

if (process.env.NODE_ENV === 'development') assertContent();
