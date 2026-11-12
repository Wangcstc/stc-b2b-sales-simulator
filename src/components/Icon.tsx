/**
 * 全站图标。**线性、单色、跟随 currentColor。**
 *
 * ★ 为什么不用 emoji ★ 这一套在 2026-08-26 之前全是 emoji：导航是 📥🎯🎛️👥、
 * 导出是 📑、帮助是 ❓、主题是 🌙。emoji 由**操作系统**渲染，不是由页面渲染，
 * 于是三件事同时失控：
 *   ① 颜色不归我们管——Windows 上是 Segoe UI Emoji 的卡通彩图，
 *     和这一套克制的深色配色直接打架，还盖过了它旁边真正要看的数字；
 *   ② 每个系统长得都不一样——Mac、Windows、安卓各一套字形，截图对不上；
 *   ③ 它们不在任何中文字体里，会白白拖下 3.8MB 的生僻字包
 *     （见 fonts.ts 里 scExt 那段 unicode-range 的注释，那正是这么来的）。
 *
 * ★ 内联 SVG，不引图标库 ★ 全站只用到十几个图标，装一个运行时依赖不划算。
 * 路径取自 Lucide（ISC 协议），24×24 网格、描边式，与母版的线性风格一致。
 *
 * ★ 描边宽度 1.75 ★ Lucide 原生是 2，那是给 24px 用的；这里图标普遍摆在
 * 14–18px，2 会显得糊、和 400 字重的正文不搭。1.75 是实际尺寸下最接近文字灰度的那一档。
 *
 * 【加新图标】把 Lucide 对应的 path 抄进 PATHS 即可，别改 viewBox 和描边参数——
 * 这两个一动，全站图标的视觉重量就不一套了。
 */

export type IconName =
  | 'inbox'      // 模拟询盘
  | 'target'     // 考试闸门 / 考试记录
  | 'sliders'    // 教练台 / 训练台
  | 'users'      // 账号管理
  | 'download'   // 台账导出
  | 'help'       // 帮助
  | 'moon'       // 深色
  | 'sun'        // 浅色
  | 'compass'    // 新手指引
  | 'refresh'    // 换一批
  | 'flag'       // 黑名单标记
  | 'alert'      // 警告
  | 'paperclip'  // 附件 / 产品目录
  | 'check'      // 达成 / 通过
  | 'lock'       // 未解锁
  | 'unlock'     // 已解锁
  | 'award'      // 拿到准入资格
  | 'x'          // 关闭浮层
  | 'book'       // 帮助中心 / 使用说明
  | 'play'       // 开考 / 开始这一局
  | 'layers';    // 题库工坊

/** 每个图标就是一组 <path>/<circle>/<line>，统一在 24×24 网格上 */
const PATHS: Record<IconName, React.ReactNode> = {
  inbox: (
    <>
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
    </>
  ),
  sliders: (
    <>
      <line x1="21" x2="14" y1="4" y2="4" />
      <line x1="10" x2="3" y1="4" y2="4" />
      <line x1="21" x2="12" y1="12" y2="12" />
      <line x1="8" x2="3" y1="12" y2="12" />
      <line x1="21" x2="16" y1="20" y2="20" />
      <line x1="12" x2="3" y1="20" y2="20" />
      <line x1="14" x2="14" y1="2" y2="6" />
      <line x1="8" x2="8" y1="10" y2="14" />
      <line x1="16" x2="16" y1="18" y2="22" />
    </>
  ),
  users: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </>
  ),
  download: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5" />
      <path d="M12 15V3" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <path d="M12 17h.01" />
    </>
  ),
  moon: <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" />
      <path d="m19.07 4.93-1.41 1.41" />
    </>
  ),
  compass: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="m16.24 7.76-2.12 6.36-6.36 2.12 2.12-6.36 6.36-2.12z" />
    </>
  ),
  refresh: (
    <>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </>
  ),
  flag: (
    <>
      <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
      <line x1="4" x2="4" y1="22" y2="15" />
    </>
  ),
  alert: (
    <>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </>
  ),
  paperclip: (
    <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  ),
  check: (
    <>
      <path d="M21.8 10A10 10 0 1 1 17 3.34" />
      <path d="m9 11 3 3L22 4" />
    </>
  ),
  lock: (
    <>
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </>
  ),
  unlock: (
    <>
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 9.9-1" />
    </>
  ),
  award: (
    <>
      <circle cx="12" cy="8" r="6" />
      <path d="M15.477 12.89 17 22l-5-3-5 3 1.523-9.11" />
    </>
  ),
  x: (
    <>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </>
  ),
  book: (
    <>
      <path d="M12 7v14" />
      <path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />
    </>
  ),
  // Lucide play。★ 用描边不用实心 ★ 实心三角在 14px 上比同排的线性图标重一档，
  // 会把「开始」那个按钮里的字压下去
  play: <path d="M6 4.5v15l13-7.5-13-7.5Z" />,
  // Lucide layers：一层层叠起来的题库
  layers: (
    <>
      <path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" />
      <path d="m2 12 9.17 4.17a2 2 0 0 0 1.66 0L22 12" />
      <path d="m2 17 9.17 4.17a2 2 0 0 0 1.66 0L22 17" />
    </>
  ),
};

export default function Icon({
  name,
  size = 16,
  label,
  className,
  style,
}: {
  name: IconName;
  /** 像素。跟着它旁边文字的字号走，别比文字大太多 */
  size?: number;
  /**
   * 有意义的图标要给它一句话（纯图标按钮、状态标记）；
   * 不给就是装饰性的，对读屏软件隐藏——旁边已经有文字的图标都属于这一类。
   */
  label?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      /* 图标要和相邻文字的基线对齐；不给 flex-shrink 的话它在窄容器里会被压扁 */
      style={{ flexShrink: 0, display: 'block', ...style }}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {PATHS[name]}
    </svg>
  );
}
