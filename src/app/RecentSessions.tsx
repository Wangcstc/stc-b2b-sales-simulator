'use client';

import { useState } from 'react';
import Link from 'next/link';
import Pager, { paginate, PAGE_SIZE } from '@/components/Pager';

/**
 * 首页「最近的局」列表 + 翻页条。
 *
 * ★ 为什么单独拎成客户端组件 ★ 首页是服务端组件，翻页要存 page 状态。
 * 拎出来的同时也把「传给浏览器的字段」收窄了——见下面 Row 的注释。
 *
 * ★ 一页 10 行 ★ 与教练台的历史台账、登录流水共用 `Pager`（2026-08-21 王老师定）。
 */

/**
 * ★ 只放这几个字段 ★（首页那条老注释的延伸）
 * 首页原来一度用 `include: { variant: { include: { persona: true } } }`，
 * 把整行人设（含暗牌、离场台词、报价反应）序列化进了 HTML——
 * 最近练过的那几封，答案就印在网页源码里。
 * 这个组件收的是已经挑干净的字段，别往里加 variant / persona 整块。
 */
export interface Row {
  id: string;
  drillId: string;
  mode: string;
  status: string;
  personaName: string;
  tier: string | null;
  rawScore: number | null;
  precise: boolean | null;
  scored: boolean;
}

function resultOf(r: Row) {
  if (r.scored) {
    return r.precise ? (
      <b className="num" style={{ color: 'var(--text)' }}>
        {r.tier} · {r.rawScore} 分
      </b>
    ) : (
      '证据不足'
    );
  }
  return r.status === 'ENDED' ? '未评分' : '进行中';
}

export default function RecentSessions({ rows, total }: { rows: Row[]; total: number }) {
  const [page, setPage] = useState(1);
  const { pageRows, current, pageCount } = paginate(rows, page);

  return (
    <div className="section-block">
      <div className="section-title">
        最近的局
        <span className="sub">
          共 <span className="num">{total}</span> 局
          {/* ★ 列不全就说出来 ★ 标题写 200、实际有 300，那是无声截断 */}
          {total > rows.length && <>（列出最近 {rows.length}）</>}
          {pageCount > 1 && <>　每页 {PAGE_SIZE} 条</>}
        </span>
      </div>

      {/* ★ 2026-08-28 去框 ★ 一个 .section-title 带一个列表，边界标题已经给了。
          行与行靠发丝线分开（.list-row），首尾贴着左基线，和上面那些表对齐。
          布局也从每行的内联 style 收进 CSS——原来是 flex/gap/padding 一行行写在这儿，
          换成 .list-row 之后「一条列表长什么样」全站只有一份定义。 */}
      <div className="list-wrap">
        {pageRows.map((s) => (
          <Link
            key={s.id}
            className="list-row"
            href={s.scored ? `/report/${s.id}` : `/drill/${s.id}`}
          >
            <span
              className="small"
              style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {(s.mode === 'EXAM' || s.mode === 'ADMISSION_EXAM') && (
                <span className="chip warn tiny" style={{ marginRight: 8 }}>
                  考试
                </span>
              )}
              {s.personaName}
              <span className="faint mono" style={{ marginLeft: 8 }}>
                {s.drillId}
              </span>
            </span>
            <span className="small muted" style={{ whiteSpace: 'nowrap' }}>
              {resultOf(s)}
            </span>
          </Link>
        ))}
      </div>

      <Pager current={current} pageCount={pageCount} onChange={setPage} />
    </div>
  );
}
