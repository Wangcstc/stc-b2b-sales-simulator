'use client';

import { useEffect, useMemo, useState } from 'react';
import Pager, { paginate } from './Pager';
import { InquiryRow } from './InquiryRow';
import {
  BUCKET,
  BUCKET_ORDER,
  pickRandom,
  type Bucket,
  type InquiryCard,
  type PersonaGroup,
  type PlayRecord,
} from '@/lib/inquiry-pool';
import Icon from './Icon';
import EmptyState from './EmptyState';

/**
 * 询盘题库：全池 104 封，按考点分组，可筛可随机。
 *
 * ★ 这一页存在的理由 ★ 首页只派三封，那是给「今天该练什么」用的；
 * 但「我想专门练砍价」「主管让我把交付执行那一组过一遍」这类需求也真实存在，
 * 全池不能锁起来。区别在于：来这一页的人是**带着目的**来的，
 * 所以给他筛选器，而不是给他一张 104 行的表让他从头往下摸。
 *
 * ★ 筛选状态用 useState，不回写 URL ★ 全站惯例（TaskLedger / SessionFlow 都这样）。
 * URL 只喂初始值——主管发一条 /inquiries?persona=P26 过来，落地就是筛好的，
 * 但之后的点选不改地址栏，免得每次筛选都往历史记录里塞一条。
 */

type DiffFilter = 'ALL' | Bucket;
type TypeFilter = 'ALL' | 'INQUIRY' | 'FOLLOWUP';
type StatusFilter = 'ALL' | 'NEW' | 'PLAYED';

export interface LibraryInitial {
  persona?: string;
  diff?: string;
  type?: string;
  status?: string;
}

function asDiff(v: string | undefined): DiffFilter {
  return v === 'simple' || v === 'standard' || v === 'hard' ? v : 'ALL';
}
function asType(v: string | undefined): TypeFilter {
  return v === 'INQUIRY' || v === 'FOLLOWUP' ? v : 'ALL';
}
function asStatus(v: string | undefined): StatusFilter {
  return v === 'NEW' || v === 'PLAYED' ? v : 'ALL';
}

export default function InquiryLibrary({
  groups,
  records,
  initial,
}: {
  groups: PersonaGroup<InquiryCard>[];
  records: Record<string, PlayRecord>;
  initial: LibraryInitial;
}) {
  const [diff, setDiff] = useState<DiffFilter>(asDiff(initial.diff));
  const [type, setType] = useState<TypeFilter>(asType(initial.type));
  const [persona, setPersona] = useState<string>(
    initial.persona && groups.some((g) => g.code === initial.persona) ? initial.persona : 'ALL',
  );
  const [status, setStatus] = useState<StatusFilter>(asStatus(initial.status));
  const [onlyBg, setOnlyBg] = useState(false);
  const [page, setPage] = useState(1);

  const totalVariants = useMemo(() => groups.reduce((n, g) => n + g.variants.length, 0), [groups]);
  const bgCount = useMemo(
    () => groups.reduce((n, g) => n + g.variants.filter((v) => v.hasBg).length, 0),
    [groups],
  );
  const diffCount = useMemo(() => {
    const map = new Map<Bucket, number>();
    for (const g of groups) map.set(g.bucket, (map.get(g.bucket) ?? 0) + g.variants.length);
    return map;
  }, [groups]);
  const typeCount = useMemo(() => {
    let inquiry = 0;
    for (const g of groups) if (g.sessionType === 'INQUIRY') inquiry += g.variants.length;
    return { INQUIRY: inquiry, FOLLOWUP: totalVariants - inquiry };
  }, [groups, totalVariants]);

  /** 先按考点级条件筛掉整组，再按封级条件筛组里的封；筛空了的组不出现 */
  const visible = useMemo(() => {
    const out: PersonaGroup<InquiryCard>[] = [];
    for (const group of groups) {
      if (diff !== 'ALL' && group.bucket !== diff) continue;
      if (type !== 'ALL' && group.sessionType !== type) continue;
      if (persona !== 'ALL' && group.code !== persona) continue;

      const variants = group.variants.filter((v) => {
        if (onlyBg && !v.hasBg) return false;
        const played = (records[v.id]?.count ?? 0) > 0;
        if (status === 'NEW' && played) return false;
        if (status === 'PLAYED' && !played) return false;
        return true;
      });
      if (variants.length === 0) continue;
      out.push({ ...group, variants });
    }
    return out;
  }, [groups, diff, type, persona, status, onlyBg, records]);

  const visibleVariants = useMemo(() => visible.flatMap((g) => g.variants), [visible]);

  // 换了条件还停在第 3 页，多半是一片空白——一律回第一页
  useEffect(() => setPage(1), [diff, type, persona, status, onlyBg]);
  const { pageRows, current, pageCount } = paginate(visible, page);

  function goRandom() {
    const one = pickRandom(visibleVariants);
    if (one) window.location.href = `/api/start?variantId=${encodeURIComponent(one.variantId)}`;
  }

  return (
    <div>
      <div className="filter-bar">
        <div>
          <label htmlFor="lib-diff">难度</label>
          <select id="lib-diff" value={diff} onChange={(e) => setDiff(e.target.value as DiffFilter)}>
            <option value="ALL">全部（{totalVariants} 封）</option>
            {BUCKET_ORDER.map((b) => (
              <option key={b} value={b}>
                {BUCKET[b].label}（{diffCount.get(b) ?? 0} 封）
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="lib-type">局型</label>
          <select id="lib-type" value={type} onChange={(e) => setType(e.target.value as TypeFilter)}>
            <option value="ALL">全部</option>
            <option value="INQUIRY">探需局（{typeCount.INQUIRY} 封）</option>
            <option value="FOLLOWUP">跟进局（{typeCount.FOLLOWUP} 封）</option>
          </select>
        </div>

        <div>
          <label htmlFor="lib-persona">考点</label>
          <select id="lib-persona" value={persona} onChange={(e) => setPersona(e.target.value)}>
            <option value="ALL">全部（{groups.length} 个考点）</option>
            {groups.map((g) => (
              <option key={g.code} value={g.code}>
                {g.name}（{g.variants.length} 封）
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="lib-status">练过没有</label>
          <select id="lib-status" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
            <option value="ALL">全部</option>
            <option value="NEW">还没练过</option>
            <option value="PLAYED">练过的</option>
          </select>
        </div>

        <button
          type="button"
          className={onlyBg ? 'filter-toggle on' : 'filter-toggle'}
          aria-pressed={onlyBg}
          onClick={() => setOnlyBg(!onlyBg)}
        >
          <span className="box">{onlyBg ? '✓' : ''}</span>
          只看含背调包
          <span className="n">{bgCount}</span>
        </button>

        {/* ★ 随机按钮不是玩具 ★ 一页 32 组摆在这儿，人还是会从第一组开始点。
            「随便来一封」给的是一个不用做决定的入口，也是打散位置偏差的最后一道保险 */}
        <button type="button" className="filter-toggle" onClick={goRandom} disabled={visibleVariants.length === 0}>
          <span className="box"><Icon name="refresh" size={10} /></span>
          随机来一封
          <span className="n">{visibleVariants.length}</span>
        </button>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          filtered
          title="这些筛选条件下没有询盘。"
          hint="换个考点、换个难度，或者把「练过没练过」放宽。"
          action={
            <button
              type="button"
              className="ghost small"
              onClick={() => { setDiff('ALL'); setType('ALL'); setPersona('ALL'); setStatus('ALL'); setOnlyBg(false); setPage(1); }}
            >
              清空筛选
            </button>
          }
        />
      ) : (
        <>
          <div className="igroups">
            {pageRows.map((group) => (
              <details
                key={group.code}
                className="igroup"
                style={{ ['--stripe' as string]: BUCKET[group.bucket].color }}
                open={persona !== 'ALL'}
              >
                <summary>
                  <span className="irow-caret">▶</span>
                  <span className="igroup-label" style={{ color: BUCKET[group.bucket].color }}>
                    {group.name}
                  </span>
                  <span className="igroup-count">
                    {BUCKET[group.bucket].label} · {group.sessionType === 'FOLLOWUP' ? '跟进局' : '探需局'} ·{' '}
                    <span className="num">{group.variants.length}</span> 封 ·{' '}
                    {group.playedVariants > 0 ? (
                      <>
                        练过 <span className="num">{group.playedVariants}</span> 封
                      </>
                    ) : (
                      '没练过'
                    )}
                  </span>
                  <span className="igroup-hint">考：{group.tests}</span>
                </summary>

                <div className="ilist igroup-list">
                  {group.variants.map((v) => (
                    <InquiryRow key={v.id} card={v} record={records[v.id]} />
                  ))}
                </div>
              </details>
            ))}
          </div>
          <Pager current={current} pageCount={pageCount} onChange={setPage} />
        </>
      )}
    </div>
  );
}
