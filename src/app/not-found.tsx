import Link from 'next/link';

/**
 * 全站 404。
 * ★ 为什么要自己写 ★ Next 自带的是一张白底英文页（「404 | This page could not be found」），
 * 在深色站点里像整页出了故障，也没说下一步该去哪。
 * 这里说人话，并给出两种最常见情况的出路：
 *   · 业务员点到了只有主管能看的页面（题库工坊等）——这些页面对业务员故意显示「不存在」，
 *   · 链接过期、地址敲错。
 * 注意：不能在这里读登录状态再分情况说，404 页要保证任何时候都渲染得出来。
 */
export const metadata = { title: '找不到这一页' };

export default function NotFound() {
  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div className="card" style={{ maxWidth: 460, textAlign: 'center', display: 'grid', gap: 12 }}>
        <div className="mono" style={{ fontSize: 'var(--fs-xl, 28px)', opacity: 0.6 }}>404</div>
        <b style={{ fontSize: 'var(--fs-lg, 18px)' }}>找不到这一页</b>
        <div className="small muted" style={{ lineHeight: 1.7 }}>
          可能是链接已经失效、地址输错了，也可能这一页只有主管和管理员能打开。
          <br />
          如果你应该能看到它，请用主管账号登录再试。
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 4 }}>
          <Link href="/" className="as-btn primary">回首页</Link>
          <Link href="/signin" className="as-btn">换个账号登录</Link>
        </div>
      </div>
    </main>
  );
}
