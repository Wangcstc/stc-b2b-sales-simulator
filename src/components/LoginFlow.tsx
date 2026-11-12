'use client';

import { useState } from 'react';
import type { LoginRow } from '@/lib/board';
import Pager, { paginate } from './Pager';
import EmptyState from './EmptyState';

/**
 * 登录流水（2026-08-21 加翻页）
 *
 * ★ 一页 10 行 ★ 它是一条只增不减的流水，铺开就是几百行，
 * 把下面的东西全推到看不见的地方去。
 *
 * 这里不挂筛选：登录事件只有「谁、什么时候、什么事件」三列，
 * 要找某个人的登录记录，人少的时候一眼扫得完，人多了再说。
 */
export default function LoginFlow({ rows }: { rows: LoginRow[] }) {
  const [page, setPage] = useState(1);
  const { pageRows, current, pageCount } = paginate(rows, page);

  if (rows.length === 0) {
    return (
      <EmptyState title="还没有登录记录。" hint="下一次有人登录就会出现在这里，精确到分钟。" />
    );
  }

  return (
    <div>
      <div className="ledger-wrap">
        <table className="team-table ledger">
          <thead>
            <tr>
              <th>时间</th>
              <th>业务员</th>
              <th>事件</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((item) => (
              <tr key={item.id}>
                <td className="mono tiny">{item.at}</td>
                <td>
                  <b>{item.userName}</b> <span className="faint mono tiny">{item.userCode}</span>
                </td>
                <td className="muted">{item.kindText}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Pager current={current} pageCount={pageCount} onChange={setPage} />
    </div>
  );
}
