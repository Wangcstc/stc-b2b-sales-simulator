'use client';

/**
 * 翻页条。教练台的历史台账、历史记录、登录流水、红线复核共用。
 *
 * ★ 一页 10 行 ★（2026-08-21 王老师定）表是用来翻的，不是用来一路滚到底的。
 * 只有一页时整条不出现——一个永远点不动的「下一页」是噪音。
 */
export const PAGE_SIZE = 10;

/** 切出第 page 页。page 会被夹在合法范围内，筛完变短了也不会停在空白页 */
export function paginate<T>(rows: T[], page: number): { pageRows: T[]; current: number; pageCount: number } {
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const current = Math.min(Math.max(1, page), pageCount);
  return { pageRows: rows.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE), current, pageCount };
}

export default function Pager({
  current,
  pageCount,
  onChange,
}: {
  current: number;
  pageCount: number;
  onChange: (page: number) => void;
}) {
  if (pageCount <= 1) return null;
  return (
    <div className="pager">
      <button type="button" className="pager-btn" disabled={current <= 1} onClick={() => onChange(current - 1)}>
        上一页
      </button>
      <span className="pager-at">
        第 <span className="num">{current}</span> / <span className="num">{pageCount}</span> 页
      </span>
      <button type="button" className="pager-btn" disabled={current >= pageCount} onClick={() => onChange(current + 1)}>
        下一页
      </button>
    </div>
  );
}
