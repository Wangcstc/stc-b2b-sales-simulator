'use client';

import { useEffect, useMemo, useState } from 'react';
import { STAGE_LABEL, type Stage } from '@/lib/admission-v11';
import type { DailyTaskRow } from '@/lib/board';
import { TaskCells } from './TaskCells';
import { TASK_COLUMNS } from '@/lib/task-columns';
import Pager, { paginate } from './Pager';
import EmptyState from './EmptyState';

/**
 * 历史台账（2026-08-21 重做，王老师定）
 *
 * ★ 原来是「一天一张小卡片」★ 七个业务日就是七张卡、七个圆角框，中间还夹着日期标题。
 * 主管真正要问的是「某个业务员这两周是怎么走的」——那得跨七张卡片自己拼，
 * 而且每张卡都没有表头，七列全靠数位置。
 *
 * 现在是一张连续的表：**一行一人一天，日期就是第一列**，
 * 上面挂人员 / 期别 / 日期三组筛选。点某个人就只剩他的行，从上往下就是他的走势。
 *
 * ★ 筛选器是这个部件自己的，不跟别处共用 ★（王老师定）
 * 台账问的是「这两周他怎么走的」，历史记录问的是「今天谁在练」，
 * 要筛的东西和粒度本来就不同。共用一套迟早互相将就。
 */

/** 日期档位。台账按周看，不摆「最近 1 天」那种粒度 */
const DATE_RANGES = [
  { value: 7, text: '近 7 天' },
  { value: 14, text: '近 14 天' },
  { value: 30, text: '近 30 天' },
];

type Who = 'ALL' | string;
type StageFilter = 'ALL' | Stage;

export default function TaskLedger({ rows }: { rows: DailyTaskRow[] }) {
  const [who, setWho] = useState<Who>('ALL');
  const [stage, setStage] = useState<StageFilter>('ALL');
  const [range, setRange] = useState<number | 'ALL'>('ALL');
  const [page, setPage] = useState(1);

  // 台账里出现过的人。按第一次出现的顺序排，和上面「今日判定」那张表一致
  const people = useMemo(() => {
    const seen = new Map<string, { userId: string; name: string; code: string }>();
    for (const row of rows) {
      if (!seen.has(row.userId)) seen.set(row.userId, { userId: row.userId, name: row.name, code: row.code });
    }
    return [...seen.values()];
  }, [rows]);

  const days = useMemo(() => [...new Set(rows.map((row) => row.day))].sort((a, b) => (a < b ? 1 : -1)), [rows]);


  const visible = useMemo(() => {
    const cutoff = typeof range === 'number' ? days.slice(0, range) : null;
    return rows.filter((row) => {
      if (who !== 'ALL' && row.userId !== who) return false;
      if (stage !== 'ALL' && row.stage !== stage) return false;
      if (cutoff && !cutoff.includes(row.day)) return false;
      return true;
    });
    // rows 已经是「日期从新到旧、同一天按花名册顺序」，这里只过滤不重排
  }, [rows, who, stage, range, days]);

  // 换了筛选条件还停在第 3 页，多半是一片空白——一律回到第一页
  useEffect(() => setPage(1), [who, stage, range]);
  const { pageRows, current, pageCount } = paginate(visible, page);

  if (rows.length === 0) {
    return (
      <EmptyState title="还没有历史记录。" hint="第一天有人开局、当晚结算跑过之后，这里就会长出来，一天一行。" />
    );
  }

  return (
    <div>
      {/* ── 筛选条：三个下拉，一行均匀分布 ──
          原来是一排 chip，人一多就排成两三行；下拉每组只占一格，
          当前选的是什么直接写在框里 */}
      <div className="filter-bar">
        <div>
          <label htmlFor="ledger-who">业务员</label>
          <select id="ledger-who" value={who} onChange={(event) => setWho(event.target.value)}>
            <option value="ALL">全部（{people.length} 人）</option>
            {people.map((person) => (
              <option key={person.userId} value={person.userId}>
                {person.name}　{person.code}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="ledger-stage">期别</label>
          <select
            id="ledger-stage"
            value={stage}
            onChange={(event) => setStage(event.target.value as StageFilter)}
          >
            <option value="ALL">全部</option>
            <option value="TRAINING">{STAGE_LABEL.TRAINING}</option>
            <option value="ACTIVE">{STAGE_LABEL.ACTIVE}</option>
          </select>
        </div>

        <div>
          <label htmlFor="ledger-range">日期</label>
          <select
            id="ledger-range"
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
      </div>

      {/* ── 台账本体：一张连续的表，表头冻在顶上 ── */}
      {visible.length === 0 ? (
        <EmptyState
          filtered
          title="这些筛选条件下没有记录。"
          hint="换个人、换个期别，或者把时间范围放宽。"
          action={
            <button
              type="button"
              className="ghost small"
              onClick={() => { setWho('ALL'); setStage('ALL'); setRange('ALL'); setPage(1); }}
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
                <th>日期</th>
                <th>业务员</th>
                <th>{TASK_COLUMNS.stage}</th>
                <th>{TASK_COLUMNS.drill}</th>
                <th>{TASK_COLUMNS.window}</th>
                <th>{TASK_COLUMNS.baseTask}</th>
                <th>{TASK_COLUMNS.gates}</th>
                <th>{TASK_COLUMNS.gap}</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((row, index) => {
                // 同一天的行不再各占一张卡，只在换天时描一条稍重的线——
                // 既连成一张表，又看得出天与天的界
                const newDay = index === 0 || pageRows[index - 1]!.day !== row.day;
                return (
                  <tr key={`${row.day}-${row.userId}`} className={newDay && index > 0 ? 'day-break' : undefined}>
                    <td className="mono tiny faint">{row.day}</td>
                    <td>
                      <b>{row.name}</b> <span className="faint mono tiny">{row.code}</span>
                    </td>
                    <TaskCells row={row} td={{}} />
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Pager current={current} pageCount={pageCount} onChange={setPage} />
    </div>
  );
}
