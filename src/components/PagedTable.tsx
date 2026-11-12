'use client';

import { Children, useState, type CSSProperties, type ReactNode } from 'react';
import Pager, { paginate } from './Pager';

/**
 * 会一直变长的表，套上它就有翻页条。
 *
 * ★ 为什么是「接住已渲染好的行」，不是把表改成客户端组件 ★
 * 要翻页的这几张表（账号一览、管理动作流水、今日判定、周考台账）全在 Server Component 里，
 * 数据是 `await prisma` 直接取的，行里还挂着 server action 的 `<form>`。
 * 把它们整体改写成 'use client' 要么得再造一套取数接口，要么得把 10 个表单动作全搬走——
 * 那是另一件事，而且每搬一个就多一次把权限判断漏在客户端的机会。
 * 这里走的是另一条路：**行照旧在服务端渲染**，当作 children 传进来，
 * 客户端只负责 `slice` 出当前这一页。server action 是可序列化的引用，穿过这一层照常能用。
 *
 * 代价说清楚：整份行都会进 RSC 载荷，翻页不回服务端。所以这一层只配给
 * **已经在取数处封了顶**（take 40 / 60 / 8 周）或**天然有限**（一人一行）的表用。
 * 真到了几千行那一天，要的是接口分页，不是这个组件——别拿它硬扛。
 *
 * ★ 空表不归它管 ★ 「还没有人手工改过期别」那种话各页自己写，措辞都不一样，
 * 收进来只会变成一句谁都不认的「暂无数据」。
 */
export default function PagedTable({
  head,
  children,
  className = 'team-table',
  cols,
  tableStyle,
  wrapStyle,
}: {
  /** 表头那一整行 `<tr>`。原样塞进 `<thead>` */
  head: ReactNode;
  /** `<tbody>` 里的那些 `<tr>`，通常是 `rows.map(...)` 的结果 */
  children: ReactNode;
  className?: string;
  /**
   * 列宽，一列一个（'46px' / '13%'）。给了就转成 `<colgroup>` 并锁死表格布局。
   * ★ 不给列宽时列宽由内容长短决定 ★ 那样每一列的间隙都不一样宽，
   * 一眼扫过去像是随手排的——而内容一变（换个人名、多一个按钮）列宽还会跟着跳。
   */
  cols?: string[];
  tableStyle?: CSSProperties;
  /**
   * 表格外壳的样式。★ 2026-08-28 从 cardStyle 改名 ★
   * 外面那层不再是 .card 了（见下面那段），名字还叫 card 会让人以为这里能调卡片。
   */
  wrapStyle?: CSSProperties;
}) {
  const rows = Children.toArray(children);
  const [page, setPage] = useState(1);
  // paginate 会把 page 夹回合法范围——主管改完期别那一刻表会变短，
  // 停在第 4 页而数据只剩 2 页时，看到的是最后一页，不是一片空白。
  const { pageRows, current, pageCount } = paginate(rows, page);

  return (
    <>
      {/* ★ 这里原来是 <div className="card"> ★（2026-08-28 去框）
          一个 .section-title + 一张表，边界信息已经给了三遍（标题左边的蓝竖条、
          标题下的分割线、上面 56px 的白），卡片是第四遍，而表自己还有表头线和行线。
          去框之后左基线由 globals.css 的 .table-wrap 首列 padding-left: 0 接管。
          ★ 这一行管着六处 ★ 账号一览、今日判定、正式业务员本周考试、周考台账、
          每日判定明细、以及训练台那两张流水——改这一处，六张表一起去框。 */}
      <div className="table-wrap" style={{ ...wrapStyle }}>
        <table
          className={className}
          /* table-layout: fixed 才让 <col> 的宽度说了算；auto 布局下它只是个建议值 */
          style={cols ? { tableLayout: 'fixed', ...tableStyle } : tableStyle}
        >
          {cols && (
            <colgroup>
              {cols.map((w, i) => (
                <col key={i} style={{ width: w }} />
              ))}
            </colgroup>
          )}
          <thead>{head}</thead>
          <tbody>{pageRows}</tbody>
        </table>
      </div>
      <Pager current={current} pageCount={pageCount} onChange={setPage} />
    </>
  );
}
