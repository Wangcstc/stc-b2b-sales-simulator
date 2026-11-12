import type { ReactNode } from 'react';

/**
 * 帮助内容的类型层 —— 全站说明文字的**唯一真源**（2026-08-27 立）
 *
 * ★ 为什么要有这一层 ★
 * 在这之前，26 段口径散在 16 个页面文件的 <Help> 里，同一件事
 * （「登录流水只有 8-20 之后的」「自由询盘不计入判定」）在三处各写一遍。
 * 改一次口径要翻遍全站，漏一处就等于界面上同时挂着两套说法。
 * 现在内容全部集中在 content/help/，页面只引用 id：
 *   · 气泡（第 2 层）读 summary —— 一句话
 *   · 抽屉（第 3 层）读 body    —— 完整口径
 *   · /help（第 4 层）读 body   —— 同一份，不是副本
 * 一处改，三处同步。
 *
 * ★ 数字一律从 lib 的配置对象取，不许写死 ★
 * 和原来 <Help> 里那条规矩一样：写死的阈值在改配置时会悄悄变成假话。
 */

/** 正文里要用到的运行时值。/help 页面没有上下文，所以每一项都必须可缺省 */
export interface HelpVars {
  /** 复盘页：这一局一共几个问题 */
  total?: number;
  /** 训练台：这个人走准入还是走周考 */
  track?: 'ADMISSION' | 'WEEKLY' | null;
}

export interface HelpSection {
  /**
   * 全站唯一的锚点 id。抽屉靠它定位、/help 靠它做深链（/help#team-role）。
   * 命名一律「页面-主题」，改名等于改 URL，别随手改。
   */
  id: string;
  /** 小标题。抽屉和 /help 的目录都用它 */
  title: string;
  /**
   * 一句话摘要，给「?」气泡用。
   *
   * ★ 硬性上限 SUMMARY_MAX 字，不分点、不换行 ★
   * 这是整套方案的关键约束：气泡装一句话，装不下就说明该去抽屉。
   * 超了会在开发环境直接报错（见 index.tsx 的 assertSummaries）。
   */
  summary: string;
  /** 完整口径。抽屉与 /help 渲染的是同一个它 */
  body: (v: HelpVars) => ReactNode;
  /**
   * 只给某一条考试轨看。
   *
   * ★ 不适用的规则比没有规则更糟 ★ 把准入那套「连着两天不达标就停你的询盘」
   * 端给一个走周考的人，他会当真。留空＝谁都该看。
   */
  only?: 'ADMISSION' | 'WEEKLY';
}

export interface HelpPage {
  /** 页面 id，如 'team'。<PageHelp page="team" /> 用它 */
  id: string;
  /** 抽屉标题栏与 /help 的分组标题 */
  title: string;
  /** 这一页在站内的路径，/help 里做跳转 */
  route: string;
  /**
   * 谁该看这一组。/help 按它分栏——
   * 把主管那套判定阈值端给业务员，等于给他看一堆对他不成立的门槛。
   */
  audience: 'staff' | 'lead' | 'all';
  /** 一句话说明这一页是干嘛的。抽屉打开第一眼看到的就是它 */
  intro: string;
  sections: HelpSection[];
}

/** 气泡摘要的字数上限。想改这个数之前先想清楚：气泡是不是又在装文档了 */
export const SUMMARY_MAX = 60;
