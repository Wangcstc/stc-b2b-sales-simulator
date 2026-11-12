'use client';

import Link, { useLinkStatus } from 'next/link';
import Icon, { type IconName } from './Icon';

/**
 * 顶部 TAB。做成客户端组件只为一件事：★ 点下去到新页面出现之间的那段空白 ★
 *
 * 这几个页面都要查库（模拟询盘数人设、考试查当日记录），一次导航几百毫秒起步。
 * 纯 CSS 的 :active 在松手那一刻就消失了，剩下的等待期页面毫无反应——
 * 新人只会以为没点上，然后连点三次。useLinkStatus 把这段 pending 接出来，
 * 在 TAB 底下跑一条扫光，"点上了，在路上"。
 *
 * 交互一共四层，从轻到重：
 *   hover  → 底色浮起 + 图标回血（灰→彩）
 *   press  → 整块下沉 1px，手感落地
 *   pending→ 底部扫光条，等多久亮多久
 *   on     → 强调色 + 下划线展开，标记"你在这"
 */

export interface TabItem {
  href: string;
  /** 图标名，取自 components/Icon.tsx。★ 不再收 emoji ★ 见那个文件顶上的注释 */
  icon: IconName;
  label: string;
  /** 角标数字，0 或 undefined 不显示 */
  badge?: number;
  /** 下载类链接（如台账导出）：交给浏览器直连，不走路由 */
  download?: boolean;
}

/** 必须放在 <Link> 内部才能拿到 pending——useLinkStatus 读的是最近一层 Link 的状态 */
function TabInner({ item }: { item: TabItem }) {
  const { pending } = useLinkStatus();
  return (
    <>
      <TabFace item={item} />
      {pending && <span className="tab-pending" aria-hidden />}
    </>
  );
}

function TabFace({ item }: { item: TabItem }) {
  return (
    <>
      <span className="ic" aria-hidden>
        <Icon name={item.icon} size={16} />
      </span>
      {item.label}
      {item.badge ? <span className="badge">{item.badge}</span> : null}
    </>
  );
}

export default function NavTabs({ items, current }: { items: TabItem[]; current: string }) {
  return (
    <nav className="tabs">
      {items.map((n) => {
        const on = current === n.href;

        // 台账导出是个下载接口，不是页面。走 <Link> 会被路由接管、拿不到文件，
        // 也永远等不到 pending 结束——这种必须留给浏览器。
        if (n.download) {
          return (
            <a key={n.href} href={n.href} className={on ? 'on' : ''}>
              <TabFace item={n} />
            </a>
          );
        }

        return (
          <Link key={n.href} href={n.href} className={on ? 'on' : ''}>
            <TabInner item={n} />
          </Link>
        );
      })}
    </nav>
  );
}
