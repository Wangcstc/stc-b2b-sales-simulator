'use client';

import { useEffect, useState } from 'react';
import Icon from './Icon';

/**
 * 深浅色切换。
 *
 * ★ 2026-08-25 重新加回 ★ 2026-08-14 曾因「手册只有浅色令牌、深色没有对应色号」
 * 把这个按钮删掉。现在皮换成了母版那套色阶，深浅两头都能在同一条色阶上取到值
 * （见 globals.css 里 :root[data-theme='light'] 那段），不需要发明色号，所以它可以回来。
 *
 * ★ 默认深色，且系统偏好不参与决定 ★
 * 这套界面是照着深色设计的（版头渐变、TAB 扫光、对话区滚动条都按深底调的），
 * 浅色是给偏好浅色的业务员的选项，不是"跟随系统"。所以不读 prefers-color-scheme——
 * 那会让一台白天自动变浅的电脑替人做主，而这个人可能根本没想换。
 *
 * ★ 存 localStorage，不存服务端 ★
 * 换个电脑要重选一次，这是有意的取舍：它是这台机器上的显示偏好，不是账号属性。
 * 存进 User 表就得为一件纯前端的事加一次写库、一条迁移和一个接口。
 *
 * ★ 首屏不许闪 ★ 真正防闪的是 layout.tsx 里那段阻塞脚本，它在 CSS 之前就把
 * data-theme 写上了。这个组件只负责点了之后改，以及把按钮画对——
 * 它自己是 useEffect 里才知道当前主题的，所以挂载前按钮不画图标（见下面的 mounted）。
 */

export const THEME_KEY = 'drill-theme';

type Theme = 'dark' | 'light';

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('dark');
  // 服务端渲染时不知道用户选的是哪个，先不画图标——
  // 画错了会先显示一个太阳再跳成月亮，比空着更晃眼
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    setTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  }, []);

  function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    // 深色是默认值，就不留属性——DOM 上少一个状态，也和防闪脚本的判断一致
    if (next === 'light') document.documentElement.dataset.theme = 'light';
    else delete document.documentElement.dataset.theme;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // 隐私模式下 localStorage 会抛。切换本身照常生效，只是刷新后不记得——
      // 为这个把整个按钮禁掉不值当
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      className="icon-btn"
      title={mounted ? (theme === 'dark' ? '切换到浅色' : '切换到深色') : '深浅色切换'}
      aria-label="深浅色切换"
      style={{ border: 'none', background: 'transparent', padding: 0 }}
    >
      {/* 没挂载前不渲染图标：服务端不知道 localStorage 里存的是哪套主题，
          先画一个再纠正就会闪一下。留空占位，挂载后补上。 */}
      <span suppressHydrationWarning style={{ display: 'flex' }}>
        {mounted ? <Icon name={theme === 'dark' ? 'moon' : 'sun'} size={16} /> : null}
      </span>
    </button>
  );
}
