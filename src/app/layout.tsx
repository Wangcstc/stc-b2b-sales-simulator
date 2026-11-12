import type { Metadata } from 'next';
import './globals.css';
import { fontVars } from './fonts';

export const metadata: Metadata = {
  /**
   * ★ title 用 template ★ 原来全站每一页的标签页都叫「STC 外贸业务沙盘」，
   * 开着四五个标签时全长一样，谁也认不出哪个是教练台、哪个是账号管理。
   * 各页自己 export 一个短 title（「教练台」），这里补后缀。
   */
  title: {
    default: 'STC 外贸业务沙盘',
    template: '%s · STC 外贸业务沙盘',
  },
  description: '阿里国际站新人业务员陪练与上岗闸门',
  applicationName: 'STC 外贸业务沙盘',
  // ★ 站点图标 ★ 之前 /favicon.ico 是 404，标签页上是一张空白纸。
  // icon.svg 与 apple-icon.png 走 Next 的 app 目录约定，这里只声明 shortcut。
  icons: { shortcut: '/icon.svg' },
  // 内部工具，别进搜索引擎
  robots: { index: false, follow: false },
  openGraph: {
    title: 'STC 外贸业务沙盘',
    description: '阿里国际站新人业务员陪练与上岗闸门',
    siteName: 'STC 外贸业务沙盘',
    type: 'website',
  },
};

/**
 * ★ suppressHydrationWarning 只加在 html / body 这两个标签上 ★
 *
 * 原因：浏览器扩展（翻译类、密码管理器、广告拦截等）习惯在 React 接管之前
 * 往 <html> / <body> 上塞属性。比如 Trancy 会加 `trancy-version="7.9.1"`：
 * 服务端渲染出来没有这个属性、客户端有，React 就报 hydration 不匹配。
 * 这是扩展干的，不是我们的 bug——但警告浮层会挡住整个页面，
 * 更麻烦的是它会把真正的错误一起淹掉。
 *
 * 【不许往别处加这个属性】。它只压制这一层的属性差异；
 * 加到业务组件上，会把真正的服务端/客户端不一致（Date.now()、Math.random()、
 * 按本地时区格式化日期）一起盖掉——那种 bug 藏起来比报出来危险得多。
 */
/**
 * ★ 防闪脚本：必须同步执行，必须在 body 之前 ★
 *
 * 主题存在 localStorage 里，而 localStorage 只有浏览器读得到——服务端渲染出来的
 * HTML 一律是默认的深色。选了浅色的人如果等到 React 挂载后才改，中间会有一帧
 * 整页深色再跳白，每次翻页闪一下。
 *
 * 这段脚本在 <head> 里同步跑：它早于首次绘制，也早于 CSS 应用到元素上，
 * 所以属性写上去的时候页面还没画出来，一帧都不会闪。
 *
 * 用 dangerouslySetInnerHTML 是 Next 里插内联脚本的常规写法；内容是写死的常量字符串，
 * 不拼接任何用户数据，没有注入面。try/catch 是给隐私模式的——那里读 localStorage 会抛，
 * 抛了就当默认深色，不能让整页白屏。
 *
 * ★ 这里的 'drill-theme' 必须和 ThemeToggle 里的 THEME_KEY 一致 ★
 * 不 import 常量是有意的：这段字符串要在 React 之前跑，不能依赖任何模块加载。
 */
const THEME_SCRIPT = `try{if(localStorage.getItem('drill-theme')==='light'){document.documentElement.dataset.theme='light'}}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" className={fontVars} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
