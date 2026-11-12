'use client';

import { useState } from 'react';
import Help from '@/components/Help';

/**
 * 背调面板（需求第 6 章）
 *
 * ★ 交互设计的用意 ★
 * AI 报告是一键出的，但官网/社媒/号码要一项一项点开——
 * 因为第一课 7.4 的考点就是「AI 会乱抓，你要自己交叉验证」。
 * 只看 AI 报告不点开任何一项，等于没做背调，系统会记下来。
 */
/**
 * ★「查不到」必须显示成「无记录」，不能显示成 null ★
 * 有的客户根本查不出任何东西（P12 就是整包空白），而那恰恰是最强的一条结论。
 * 直接 String(null) 会印出 "null"，看着像系统坏了，新人就不会把它当证据读。
 */
const val = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return '— 无记录';
  if (Array.isArray(v)) return v.length > 0 ? v.join('、') : '— 无记录';
  return String(v);
};

/** 社媒与公开渠道的展示名。查不到的渠道也要列出来——列出来才看得见「这里是空的」 */
const CHANNEL_LABEL: Record<string, string> = {
  facebook: 'Facebook',
  facebook_personal: 'Facebook 个人页',
  facebook_company_page: 'Facebook 公司主页',
  tiktok: 'TikTok',
  linkedin: 'LinkedIn',
  instagram: 'Instagram',
  amazon_storefront: '亚马逊店铺页',
  invitation_letter_sample: '邀请函样本溯源',
};

/**
 * 字段展示名。★ 没登记的字段也要显示（回落成原 key）★
 * 2026-08-08 踩到的：面板原来只渲染 url/title/categories/about/contact_footer 与
 * handle/followers/bio 那几个写死的字段，于是新背调包里
 * 「LinkedIn 只有 2 名员工」「公司主页负责人是另一个人」「官网缺哪些页」
 * 这些**恰恰是识破路径本身**的字段，一个都渲染不出来——
 * 资料包写得再好，新人在界面上看不到就等于不存在。
 */
const FIELD_LABEL: Record<string, string> = {
  pages_found: '查到的页面',
  pages_missing: '没有的页面',
  domain_registered: '域名注册于',
  employees_listed: '页面显示员工数',
  recent_activity: '近期动态',
  company_page: '有公司页',
  page_exists: '主页存在',
  listed_owner: '页面登记的负责人',
  listed_owner_role: '负责人职位',
  job_title_listed: '本人填写的职位',
  storefront_age: '店铺开设于',
  listings_shown: '在售商品',
  note: '说明',
  whatsapp_business_name: 'WhatsApp 商务档案名',
};

/** 已经单独渲染过的字段，不要在「其余字段」里再出现一次 */
const WEBSITE_RENDERED = new Set(['url', 'title', 'categories', 'about', 'contact_footer']);
const CHANNEL_RENDERED = new Set(['handle', 'followers', 'bio', 'recent_posts', 'products_shown', 'findings']);
const CONTACTS_RENDERED = new Set(['whatsapp', 'email_domain', 'platform_fields_hidden']);

/** 把剩下的字段逐条摆出来。布尔值转成「是/否」，数组走 val() 的顿号拼接 */
function RestFields({ obj, skip }: { obj: Record<string, unknown>; skip: Set<string> }) {
  const rest = Object.entries(obj).filter(([k]) => !k.startsWith('_') && !skip.has(k));
  if (rest.length === 0) return null;
  return (
    <>
      {rest.map(([k, v]) => (
        <div key={k}>
          {FIELD_LABEL[k] ?? k}：{typeof v === 'boolean' ? (v ? '是' : '否') : val(v)}
        </div>
      ))}
    </>
  );
}

export default function BgCheckPanel({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [viewed, setViewed] = useState<string[]>([]);

  async function load(item?: string) {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/session/${sessionId}/bgcheck`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(item ? { item } : {}),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? '调阅失败');
      setData((prev) => ({ ...(prev ?? {}), ...d }));
      setViewed(d.viewed ?? []);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const report = data?.aiReport as { title?: string; content?: string } | undefined;
  const website = data?.website as Record<string, unknown> | null | undefined;
  const social = data?.social as Record<string, Record<string, unknown>> | null | undefined;
  const contacts = data?.contacts as Record<string, string> | null | undefined;
  /** 客户在后台主动隐藏了哪些字段——隐藏这个动作本身就是一条要摆给新人看的证据 */
  const rawHidden = (data?.contacts as Record<string, unknown> | null | undefined)?.platform_fields_hidden;
  const hiddenFields: string[] = Array.isArray(rawHidden) ? (rawHidden as string[]) : [];

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', display: 'grid', placeItems: 'center', padding: 24, zIndex: 10 }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{ width: 720, maxWidth: '100%', maxHeight: '86vh', overflowY: 'auto' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <b>客户背景调查</b>
          <button className="small" onClick={onClose}>关闭</button>
        </div>

        {!data && (
          <div style={{ marginTop: 16 }}>
            <p className="small muted">
              只对核心客户（≥300 美金）做深度背调。对小单客户耗大量轮次做背调，正常消耗客户耐心，不加分。
            </p>
            <button className="primary" onClick={() => load()} disabled={busy}>
              {busy ? '调阅中…' : '发起背调'}
            </button>
          </div>
        )}

        {report && (
          <>
            <div className="card" style={{ marginTop: 14, background: 'var(--panel-2)' }}>
              <b className="small">{report.title}</b>
              <p className="small" style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>{report.content}</p>
            </div>

            <div style={{ marginTop: 14 }}>
              <Help topic="drill-bgcheck" label="下面这几项怎么用" />
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              {(
                [
                  ['website', '查官网'],
                  ['social', '查社媒'],
                  ['contacts', '比对联系方式'],
                ] as const
              ).map(([key, label]) => (
                <button key={key} className="small" onClick={() => load(key)} disabled={busy || viewed.includes(key)}>
                  {viewed.includes(key) ? `✓ ${label}` : label}
                </button>
              ))}
            </div>

            {website && (
              <div className="card" style={{ marginTop: 12 }}>
                <b className="small">官网快照 · {val(website.url)}</b>
                <div className="small" style={{ marginTop: 6 }}>
                  <div>标题：{val(website.title)}</div>
                  <div>主营类目：{val(website.categories)}</div>
                  <RestFields obj={website} skip={WEBSITE_RENDERED} />
                  {website.about != null && <div style={{ marginTop: 6 }}>{String(website.about)}</div>}
                  <div className="muted" style={{ marginTop: 6 }}>{val(website.contact_footer)}</div>
                </div>
              </div>
            )}

            {/* ★ 逐个渠道渲染，不写死 facebook / tiktok ★
                不同客户能查的渠道不一样：有人有 TikTok，有人只查得到一份被反复转发的模板文件。
                写死两个渠道，等于新增的查证渠道永远出不来。带下划线前缀的是设计注释，不展示。 */}
            {social && (
              <div className="card" style={{ marginTop: 12 }}>
                <b className="small">社交媒体与公开渠道</b>
                {Object.entries(social)
                  .filter(([k, v]) => !k.startsWith('_') && v != null && typeof v === 'object')
                  .map(([key, raw]) => {
                    const e = raw as Record<string, unknown>;
                    const lines = (['recent_posts', 'products_shown', 'findings'] as const).flatMap((f) =>
                      Array.isArray(e[f]) ? (e[f] as string[]) : [],
                    );
                    return (
                      <div key={key} className="small" style={{ marginTop: 10 }}>
                        <div className="muted">
                          {CHANNEL_LABEL[key] ?? key} · {val(e.handle)}
                          {e.followers != null && `（${String(e.followers)} 粉丝）`}
                        </div>
                        {e.bio != null && <div>{String(e.bio)}</div>}
                        <RestFields obj={e} skip={CHANNEL_RENDERED} />
                        {lines.map((p, i) => (
                          <div key={i}>· {p}</div>
                        ))}
                      </div>
                    );
                  })}
              </div>
            )}

            {contacts && (
              <div className="card" style={{ marginTop: 12 }}>
                <b className="small">联系方式</b>
                <div className="small" style={{ marginTop: 6 }}>
                  <div>WhatsApp：{val(contacts.whatsapp)}</div>
                  <div>邮箱域名：{val(contacts.email_domain)}</div>
                  <RestFields obj={contacts} skip={CONTACTS_RENDERED} />
                  {hiddenFields.length > 0 && (
                    <div style={{ marginTop: 6 }}>后台已隐藏字段：{hiddenFields.join('、')}</div>
                  )}
                </div>
              </div>
            )}

            <div className="card small muted" style={{ marginTop: 14, borderColor: 'var(--warn)' }}>
              发现矛盾之后<b>不要裸问身份</b>。要有由头、前垫后接：
              先垫一句认可 → 摆出矛盾点 → 问真实用途 → 接一个利他出口。
              直接拿背调结论去质问客户，客户会困惑，信任会掉。
            </div>
          </>
        )}

        {err && <div className="small" style={{ color: 'var(--bad)', marginTop: 10 }}>{err}</div>}
      </div>
    </div>
  );
}
