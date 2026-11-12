'use client';

import { Children, useState, type CSSProperties, type ReactNode } from 'react';
import Pager, { paginate } from './Pager';

/**
 * `PagedTable` 的非表格版：一条一个 `<div>` 堆起来的列表（考试题库那种）。
 *
 * 同一套取舍，见 `PagedTable.tsx` 顶上那段——行在服务端渲染好再传进来，
 * 这一层只切页。封顶的话也一样：这是给已经封了顶的列表用的，不是接口分页的替代品。
 *
 * ★ 2026-08-28 默认外壳从 .card 改成 .list-wrap ★ 与 PagedTable 同批去框：
 * 一个章节标题带一个列表，框是重复的第四遍边界。
 */
export default function PagedList({
  children,
  className = 'list-wrap',
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  const items = Children.toArray(children);
  const [page, setPage] = useState(1);
  const { pageRows, current, pageCount } = paginate(items, page);

  return (
    <>
      <div className={className} style={style}>
        {pageRows}
      </div>
      <Pager current={current} pageCount={pageCount} onChange={setPage} />
    </>
  );
}
