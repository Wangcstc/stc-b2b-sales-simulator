'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import type { FlowRow } from '@/lib/board';
import Pager, { paginate } from './Pager';
import EmptyState from './EmptyState';

/**
 * 历史记录（原「局流水」，2026-08-21 改名）
 *
 * ★ 它回答的是「那一局到底发生了什么」★
 * 上面两张表给的是结论（中位数多少、过没过），流水给的是过程：
 * 谁、什么时候开的、打的哪个人设、打了几轮，
 * 点「看」直接进那一局的对话或报告。判定有争议、或者要复盘某一局，入口只有这里。
 *
 * ★ 没有「红线」列 ★（2026-08-21）红线退出准入判定之后，摆在这张表上
 * 只会让人以为它还在卡资格。要看某一局踩了什么红线，点「看」进那一局的报告。
 *
 * ★ 筛选器是这个部件自己的，不跟别处共用 ★（王老师定）
 * 流水要筛的东西和台账不是一回事，粒度也不同（流水问「今天谁在练」，
 * 台账问「这两周他怎么走的」）。共用一套迟早互相将就。
 *
 * ★ 按钮一律摆出来，不按数据有无来藏 ★
 * 之前写了「只有一个人就不摆业务员筛选」，结果库里全是同一个人，整组消失，
 * 看的人只会以为功能没做。筛选器该在的位置就一直在那儿。
 */

type Kind = 'ALL' | '考试' | '自由询盘';

/** 日期档位。流水最常问的是「今天谁在练」，所以从 1 天起 */
const DATE_RANGES = [
  { value: 1, text: '最近 1 天' },
  { value: 3, text: '最近 3 天' },
  { value: 7, text: '最近 7 天' },
  { value: 14, text: '最近 14 天' },
];

export default function SessionFlow({ rows }: { rows: FlowRow[] }) {
  const [who, setWho] = useState<string>('ALL');
  const [kind, setKind] = useState<Kind>('ALL');
  const [range, setRange] = useState<number | 'ALL'>('ALL');
  const [hideEmpty, setHideEmpty] = useState(false);
  const [page, setPage] = useState(1);

  const people = useMemo(() => {
    const seen = new Map<string, { code: string; name: string }>();
    for (const row of rows) {
      if (!seen.has(row.userCode)) seen.set(row.userCode, { code: row.userCode, name: row.userName });
    }
    return [...seen.values()];
  }, [rows]);

  // 流水里出现过的业务日，从新到旧。日期档位按它往回数
  const days = useMemo(() => [...new Set(rows.map((row) => row.day))].sort((a, b) => (a < b ? 1 : -1)), [rows]);

  // 一轮没打就走的空局有多少。数字摆在按钮上，不点也知道有多少噪音
  const emptyCount = useMemo(() => rows.filter((row) => row.turn === 0).length, [rows]);

  const visible = useMemo(() => {
    const cutoff = typeof range === 'number' ? days.slice(0, range) : null;
    return rows.filter((row) => {
      if (who !== 'ALL' && row.userCode !== who) return false;
      if (kind !== 'ALL' && row.kind !== kind) return false;
      if (cutoff && !cutoff.includes(row.day)) return false;
      if (hideEmpty && row.turn === 0) return false;
      return true;
    });
  }, [rows, who, kind, range, hideEmpty, days]);

  // 换了筛选条件还停在第 2 页，多半是一片空白——一律回到第一页
  useEffect(() => setPage(1), [who, kind, range, hideEmpty]);
  const { pageRows, current, pageCount } = paginate(visible, page);

  if (rows.length === 0) {
    return <EmptyState title="还没有人开过局。" hint="有人在「模拟询盘」里接待第一封询盘之后，这里就会逐条长出来。" />;
  }

  return (
    <div>
      {/* ── 筛选条：四个下拉，一行均匀分布 ── */}
      <div className="filter-bar">
        <div>
          <label htmlFor="flow-who">业务员</label>
          <select id="flow-who" value={who} onChange={(event) => setWho(event.target.value)}>
            <option value="ALL">全部（{people.length} 人）</option>
            {people.map((person) => (
              <option key={person.code} value={person.code}>
                {person.name}　{person.code}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="flow-kind">类型</label>
          <select id="flow-kind" value={kind} onChange={(event) => setKind(event.target.value as Kind)}>
            <option value="ALL">全部</option>
            <option value="考试">考试</option>
            <option value="自由询盘">自由询盘</option>
          </select>
        </div>

        <div>
          <label htmlFor="flow-range">日期</label>
          <select
            id="flow-range"
            value={String(range)}
            onChange={(event) => setRange(event.target.value === 'ALL' ? 'ALL' : Number(event.target.value))}
          >
            <option value="ALL">全部（{days.length} 个业务日）</option>
            {DATE_RANGES.map((item) => (
              <option key={item.value} value={item.value}>
                {item.text}
              </option>
            ))}
          </select>
        </div>

        {/* 非此即彼的一件事，不值得做成下拉——一个开关按钮就够。
            ★ 默认不勾 ★「他开了 8 个局一个没打」本身就是要被看见的事 */}
        <button
          type="button"
          className={hideEmpty ? 'filter-toggle on' : 'filter-toggle'}
          aria-pressed={hideEmpty}
          onClick={() => setHideEmpty(!hideEmpty)}
        >
          <span className="box">{hideEmpty ? '✓' : ''}</span>
          隐藏 0 轮空局
          <span className="n">{emptyCount}</span>
        </button>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          filtered
          title="这些筛选条件下没有记录。"
          hint="换个人、换个类型，或者把时间范围放宽。"
          action={
            <button
              type="button"
              className="ghost small"
              onClick={() => { setWho('ALL'); setKind('ALL'); setRange('ALL'); setHideEmpty(false); setPage(1); }}
            >
              清空筛选
            </button>
          }
        />
      ) : (
        <div className="ledger-wrap">
          <table className="team-table ledger">
            <thead>
              <tr>
                <th>开始</th>
                <th>结束</th>
                <th>业务员</th>
                <th>类型</th>
                <th>人设</th>
                <th className="num-col">轮数</th>
                <th>局分</th>
                <th>段位</th>
                <th className="num-col">复盘</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((item) => (
                <tr key={item.sessionId}>
                  <td className="mono tiny">{item.startedAt}</td>
                  <td className="mono tiny">{item.endClock}</td>
                  <td>
                    <b>{item.userName}</b>
                  </td>
                  <td>
                    {item.kind === '考试' ? (
                      <span className="chip warn tiny">考试</span>
                    ) : (
                      <span className="chip tiny">自由询盘</span>
                    )}
                    <span className="faint" style={{ marginLeft: 6 }}>
                      {item.slot}
                    </span>
                  </td>
                  <td>
                    {item.personaName}
                    <span className="faint mono tiny" style={{ marginLeft: 6 }}>
                      {item.variantId}
                    </span>
                  </td>
                  <td className="num-col num">{item.turn}</td>
                  <td>
                    {item.precise ? (
                      <b className="num">{item.rawScore}</b>
                    ) : (
                      <span className="faint">{item.statusText}</span>
                    )}
                  </td>
                  <td>{item.tier ?? <span className="faint">—</span>}</td>
                  <td className="num-col num">{item.answerQuality ?? '—'}</td>
                  <td>
                    <Link href={item.precise ? `/report/${item.sessionId}` : `/drill/${item.sessionId}`}>看</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pager current={current} pageCount={pageCount} onChange={setPage} />
    </div>
  );
}
