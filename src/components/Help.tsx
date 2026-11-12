'use client';

import { useEffect, useRef, useState } from 'react';
import { anchorOf, findSection } from '@/content/help';
import { useHelp } from './HelpProvider';

/**
 * 第 2 层：字段级说明气泡（2026-08-21 建，2026-08-27 重做）
 *
 * ★ 这次重做改的是一件事：气泡不再装内容，只装引用 ★
 * 原来是 <Help>……八条口径……</Help>——内容直接写在页面文件里，
 * 于是同一段话在三个页面各有一份，而且越写越长，长到气泡要开滚动条。
 * 现在只传一个 id：
 *   <Help topic="team-role" />
 * 气泡显示这一节的 summary（一句话，硬上限 60 字，超了开发环境直接报错），
 * 想看全的点「看完整说明」——抽屉拉开、滚到那一节。
 *
 * ★ 为什么不留 children 这条后路 ★
 * 留了就等于留着"就地写两句"的口子，而所有失控都是从"就这一句，不算文档"开始的。
 * 内容一律进 content/help/，没有例外。
 *
 * ★ 气泡不再需要 max-height 和滚动条 ★
 * 一句话撑不出滚动条。CSS 里那两条（max-height / overflow-y）已经删了——
 * 它们当初就是为了兜住装不下的文档，现在文档有自己的容器了。
 */
export default function Help({
  /** content/help/ 里的小节 id */
  topic,
  /** 给一句提示当触发器；不给就只画一个「?」圆点 */
  label,
  /** 靠右的标题用 right，气泡才不会撑出屏幕 */
  align = 'left',
  /** 装在窄栏（演习页侧栏、弹窗）里用它，不然气泡会被容器裁掉 */
  narrow = false,
}: {
  topic: string;
  label?: string;
  align?: 'left' | 'right';
  narrow?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const ctx = useHelp();

  // 点外面 / 按 Esc 就收起来——不收的话满屏挂着几个气泡，比原来还乱
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // 当前页优先：共享小节（历史记录 / 登录流水）在教练台和训练台都有，
  // 不带这个偏好的话，训练台上的业务员会被指到他进不去的教练台那一组
  const hit = findSection(topic, ctx?.pageId ?? undefined);
  if (!hit) {
    // 内容里没有这个 id，多半是改名时漏改了引用。画一个死问号只会误导人
    if (process.env.NODE_ENV === 'development') {
      throw new Error(`<Help topic="${topic}"> 在 content/help/ 里找不到对应小节`);
    }
    return null;
  }

  const { page, section } = hit;
  // 抽屉只认已注册的当前页；跨页的（比如账号管理里指向教练台那条）走 /help 深链
  const inDrawer = ctx?.pageId === page.id;

  return (
    <span className="help" ref={ref}>
      <button
        type="button"
        className={label ? 'help-btn labeled' : 'help-btn'}
        aria-expanded={open}
        aria-label={label ?? `说明：${section.title}`}
        title={open ? '' : '看说明'}
        onClick={(e) => {
          // 有的「?」就挂在 <summary> 里，不拦住冒泡会顺手把整块折叠展开
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <span className="help-mark">?</span>
        {label && <span className="help-label">{label}</span>}
      </button>
      {open && (
        <span
          className={`help-pop${align === 'right' ? ' right' : ''}${narrow ? ' narrow' : ''}`}
          role="note"
        >
          <span className="help-pop-sum">{section.summary}</span>
          {inDrawer ? (
            <button
              type="button"
              className="help-pop-more"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setOpen(false);
                ctx?.open(section.id);
              }}
            >
              看完整说明 →
            </button>
          ) : (
            <a className="help-pop-more" href={`/help#${anchorOf(page.id, section.id)}`}>
              看完整说明 →
            </a>
          )}
        </span>
      )}
    </span>
  );
}
