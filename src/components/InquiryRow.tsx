import { BUCKET, bucketOf, playLabel, type InquiryCard, type PlayRecord } from '@/lib/inquiry-pool';
import Icon from './Icon';
import { variantDifficulty } from '@/lib/variant-difficulty';

/**
 * 一封询盘的展示件。首页的「今日待接待」卡片和题库页的列表行共用这里的零件，
 * 免得同一份客户信息在两页上长成两个样子、加个字段要改两处。
 *
 * ★ 只吃 InquiryCard，不吃 PersonaVariant ★ 那一行里挂着暗牌，
 * 一旦进了组件就会被序列化进 HTML（题库页尤其致命：104 份答案一次性外泄）。
 * 装配在 lib/inquiry-data.ts，那里连 select 都不选暗牌。
 *
 * ★ 不加 'use client' ★ 折叠用的是原生 details/summary，
 * 全站在这件事上的口径是「不为折叠引 JS」（见 globals.css 的 .irow 注释）。
 * 题库页那个 client 组件也能直接用它——它自己不带任何服务端依赖。
 */

export const FLAG: Record<string, string> = {
  Spain: '🇪🇸',
  Ghana: '🇬🇭',
  'United Kingdom': '🇬🇧',
  China: '🇨🇳',
  'United States': '🇺🇸',
  Pakistan: '🇵🇰',
  Nigeria: '🇳🇬',
  Netherlands: '🇳🇱',
  'Democratic Republic of the Congo': '🇨🇩',
  Germany: '🇩🇪',
  'Saudi Arabia': '🇸🇦',
};

/**
 * 买家等级。★ 池子里这一格有六种值 ★ A、B、C 三档，平台 L 级两档，外加一个 "-"。
 * 原来一律拼成 `{值} 级`，于是把等级藏起来的那 11 封显示成「- 级」。
 * 隐藏不是「零级」，是这个人不想被看见——按全站口径写成破折号。
 */
export function buyerLevelText(level: string): string {
  return level === '' || level === '-' ? '等级 —' : `${level} 级`;
}

export function initials(name: string): string {
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] ?? '') + (p.length > 1 ? p[p.length - 1]![0] : (p[0]?.[1] ?? ''))).toUpperCase();
}

/** 展开后那一块：行为数据 + 标签 + 询盘原文 */
export function InquiryBody({ card }: { card: InquiryCard }) {
  const followup = card.persona.sessionType === 'FOLLOWUP';

  return (
    <>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {/* 行为数据摆在标签前面——判断客户价值先看行为，再看标签 */}
        {card.productViews != null && <span className="chip num">90 天浏览 {card.productViews} 次</span>}
        {card.validInquiries != null && <span className="chip num">有效询盘 {card.validInquiries}</span>}
        {card.tags.map((t) => (
          <span key={t} className="chip">
            {t}
          </span>
        ))}
        {card.blacklisted > 0 && <span className="chip warn">被拉黑 {card.blacklisted} 次</span>}
        {card.hasBg && <span className="chip accent">含背调资料包</span>}
        <span className="chip">考：{card.persona.tests}</span>
      </div>

      {/* ★ 跟进局摆的不是询盘，是前情 ★ 标错了新人会当成客户说的话 */}
      <div>
        <div className="tiny faint" style={{ marginBottom: 5 }}>
          {followup ? '本局前情' : '询盘原文'}
        </div>
        <div className="inquiry">{card.inquiryText}</div>
      </div>
    </>
  );
}

/** 「接待」按钮。开局链路只有这一条：GET /api/start?variantId= */
export function ReceiveButton({ card, className }: { card: InquiryCard; className?: string }) {
  return (
    <a href={`/api/start?variantId=${encodeURIComponent(card.variantId)}`}>
      <button className={className ?? 'primary irow-go'}>接待</button>
    </a>
  );
}

/**
 * 题库页的一行。
 *
 * 相比改版前多了一格「我的记录」——过去这一行只说客户是谁，
 * 不说「你练过没有、练成什么样」，于是同一封被反复点开，
 * 而 104 封里另外 87 封一次都没人碰。
 */
export function InquiryRow({ card, record }: { card: InquiryCard; record: PlayRecord | undefined }) {
  const bucket = BUCKET[bucketOf(variantDifficulty(card))];
  const followup = card.persona.sessionType === 'FOLLOWUP';
  const played = record !== undefined && record.count > 0;

  return (
    <details className="irow" style={{ ['--stripe' as string]: bucket.color }}>
      <summary>
        <span className="irow-caret">▶</span>
        <span className="irow-av">{initials(card.name)}</span>
        <span className="irow-name">{card.name}</span>
        <span className="irow-co">
          {FLAG[card.country] ?? ''} {card.company}
        </span>

        <span className="irow-meta">
          {/* 一行里只留判断得靠的几件事，其余收进展开区 */}
          <span className="num">{buyerLevelText(card.buyerLevel)}</span>
          <span className="sep">·</span>
          <span className="num drop-narrow">登录 {card.loginDays} 天</span>
          <span className="sep drop-narrow">·</span>
          <span>{followup ? '跟进局' : '探需局'}</span>
          <span style={{ color: bucket.color, letterSpacing: '.05em' }}>{bucket.label}</span>
          {card.blacklisted > 0 && (
            <span className="with-ico" style={{ color: 'var(--warn)', gap: 3 }}>
              <Icon name="flag" size={12} />
              {card.blacklisted}
            </span>
          )}
          {card.hasBg && <span style={{ color: 'var(--accent-text)' }}>◈</span>}
          <span className={played ? '' : 'faint'} style={{ minWidth: 76, textAlign: 'right' }}>
            {playLabel(record)}
          </span>
        </span>

        <ReceiveButton card={card} />
      </summary>

      <div className="irow-body">
        <InquiryBody card={card} />
      </div>
    </details>
  );
}
