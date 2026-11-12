import Icon, { type IconName } from './Icon';

/**
 * 空状态。**新人第一天进系统，看得最多的就是这个。**
 *
 * ★ 为什么值得做成组件 ★ 在这之前全站 16 处空状态都是同一句写法：
 * `<div className="card small muted">还没有周考记录。</div>`——一行灰字，
 * 没有图标、没有结构，也**多半没有下一步**。它长得像"这里坏了"，
 * 而它真正要说的是"这里还没开始"。这两件事在界面上必须能一眼分开。
 *
 * ★ 三段结构，第二段最关键 ★
 *   ① title —— 缺的是什么（"还没有周考记录"）
 *   ② hint  —— **什么时候会有**（"去考一场，这里就会有本周这一行"）
 *   ③ action—— 能立刻做的那一步，可选
 * 原来的 16 句里有 5 句本来就写了第二段（登录流水、历史台账、周考台账那几条），
 * 写得很好；剩下的只有第一段。这个组件把好的那几句的做法变成默认要求。
 *
 * ★ 筛空 ≠ 空 ★ `filtered` 打开时用另一套图标与措辞：
 * "这些筛选条件下没有记录"说的是**你把它筛没了**，跟"还没开始"是两回事，
 * 而且它的下一步是"放宽筛选"，不是"去练一局"。
 */
export default function EmptyState({
  title,
  hint,
  action,
  icon,
  filtered = false,
  style,
}: {
  /** 缺的是什么。一句话，句号结尾 */
  title: string;
  /** 什么时候会有 / 该怎么做。没有真正有用的话可以不给——硬凑一句废话比不写更糟 */
  hint?: string;
  /** 能立刻点的那一步 */
  action?: React.ReactNode;
  /** 不给就按 filtered 自动选：筛空用漏斗意象，首次为空用收件箱 */
  icon?: IconName;
  filtered?: boolean;
  style?: React.CSSProperties;
}) {
  const name: IconName = icon ?? (filtered ? 'refresh' : 'inbox');
  return (
    <div className="empty" style={style} role="status">
      <span className="empty-ico" aria-hidden>
        <Icon name={name} size={20} />
      </span>
      <div className="empty-body">
        <div className="empty-title">{title}</div>
        {hint && <div className="empty-hint">{hint}</div>}
        {action && <div className="empty-action">{action}</div>}
      </div>
    </div>
  );
}
