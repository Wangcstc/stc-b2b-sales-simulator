'use client';

import { useEffect } from 'react';
import { findPage, type HelpVars } from '@/content/help';
import { useHelp } from './HelpProvider';
import Icon from './Icon';

/**
 * 第 3 层的入口按钮：「这页怎么用」
 *
 * ★ 一页一个，摆在页面大标题旁边 ★
 * 它替掉的是原来挂在标题上、装着整页口径的那个「?」。
 * 问号是「这个字段是什么意思」的手势，一页的完整说明不该用它 ——
 * 写成一个有字的按钮，人才知道点了会出来一整篇，而不是一句话。
 *
 * 顺带把当前页注册进 context：页面上的「?」气泡靠它才知道
 * 「看完整说明」该拉开哪一页的抽屉。
 */
export default function PageHelp({
  page,
  vars,
  /** 标题旁边用默认的按钮样式；塞进工具条时给 compact，只留图标 */
  compact = false,
  /**
   * 只注册、不画按钮。
   *
   * ★ 给对话页用 ★ 那一页正在计轮次，多摆一个「这页怎么用」是干扰；
   * 但侧栏里那几个「?」需要有抽屉可拉，所以页面还是得注册进 context。
   */
  hidden = false,
}: {
  page: string;
  vars?: HelpVars;
  compact?: boolean;
  hidden?: boolean;
}) {
  const ctx = useHelp();
  const register = ctx?.register;
  // vars 每次渲染都是新对象，直接进依赖会无限重注册；按内容比对
  const varsKey = JSON.stringify(vars ?? {});

  useEffect(() => {
    register?.(page, JSON.parse(varsKey) as HelpVars);
  }, [register, page, varsKey]);

  // 内容里没有这一页就别画按钮——画了点开是空的，比没有更糟
  if (hidden || !findPage(page)) return null;

  return (
    <button
      type="button"
      className={compact ? 'icon-btn' : 'page-help-btn'}
      onClick={() => ctx?.open()}
      title="这页怎么用"
      aria-label="这页怎么用"
    >
      <Icon name="book" size={compact ? 16 : 14} />
      {!compact && <span>这页怎么用</span>}
    </button>
  );
}
