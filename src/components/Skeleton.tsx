/**
 * 骨架屏。**只给「已经在路上、马上就到」的内容用。**
 *
 * ★ 为什么需要它 ★ 这几页服务端要跑很久：/train 1422ms、/replay 1194ms、/team 1004ms
 * （2026-08-26 实测，已登录、已预热）。而全站原来一个 loading.tsx / Suspense 都没有，
 * 所以点一下导航之后，那一秒多里页面完全没有动静——新人的直觉判断是「这系统卡」，
 * 然后连点三次。
 *
 * ★ 摆在 Suspense 里，不摆在 loading.tsx 里 ★ 版头 AppShell 自己只要 156ms
 * （/account 那一页基本只有版头，量出来就是这个数），慢的是页面主体。
 * 用 loading.tsx 会把**整页**换成占位，版头跟着一起消失再回来，闪一下；
 * 用 Suspense 只换主体，版头照常在，导航 TAB 上那条 pending 扫光也还在跑。
 *
 * ★ 骨架要长得像真东西 ★ 一个转圈只说明「在等」，骨架屏说明「在等什么、有多少」。
 * 所以下面几个都是照着真实版面搭的：表格给表头 + 行、卡片给标题 + 几行字。
 * 尺寸不必分毫不差，但**行数和块的大小要接近**——差太多的话内容一到位就是一次跳版。
 */

/** 一个占位块。宽度给百分比或像素都行 */
export function Bar({
  w = '100%',
  h = 12,
  style,
}: {
  w?: number | string;
  h?: number;
  style?: React.CSSProperties;
}) {
  return <span className="skeleton" style={{ width: w, height: h, ...style }} />;
}

/**
 * 表格骨架。教练台的今日判定、账号管理的三张表、周考台账都长这样。
 * `cols` 给列数、`rows` 给行数——照着那张表**真实的**行数给，别一律 5 行。
 */
export function SkeletonTable({ cols = 5, rows = 6 }: { cols?: number; rows?: number }) {
  return (
    /* ★ 骨架必须和真身同形 ★（2026-08-28）真表已经去框（见 .table-wrap），
       骨架还套着卡的话，加载完那一瞬间框会"啪"地消失——那是一次没必要的跳动，
       而骨架屏存在的全部意义就是让这一瞬间不跳。 */
    <div className="table-wrap" aria-hidden>
      <div className="skeleton-row skeleton-head">
        {Array.from({ length: cols }, (_, i) => (
          <Bar key={i} w={i === 0 ? '38%' : '58%'} h={9} />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="skeleton-row">
          {Array.from({ length: cols }, (_, i) => (
            // 每列宽度错开一点，整齐划一的灰条看着像进度条不像表格
            <Bar key={i} w={i === 0 ? '72%' : `${46 + ((r * 7 + i * 13) % 34)}%`} h={11} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** 卡片骨架：一个标题 + 若干行正文 */
export function SkeletonCard({ lines = 3, title = true }: { lines?: number; title?: boolean }) {
  return (
    <div className="card" aria-hidden>
      {title && <Bar w={150} h={14} style={{ marginBottom: 14 }} />}
      <div style={{ display: 'grid', gap: 9 }}>
        {Array.from({ length: lines }, (_, i) => (
          <Bar key={i} w={i === lines - 1 ? '58%' : '100%'} h={11} />
        ))}
      </div>
    </div>
  );
}

/** 区块标题的骨架，配合下面的表或卡一起用 */
export function SkeletonTitle({ w = 120 }: { w?: number }) {
  return (
    <div style={{ margin: '0 0 12px' }} aria-hidden>
      <Bar w={w} h={13} />
    </div>
  );
}

/**
 * 教练台 / 训练台的整块骨架。
 * 照着 CoachBoard 的真实结构：今日判定一张表 + 折叠起来的三块。
 *
 * ★ 给 role="status" 和一句话 ★ 骨架对读屏软件是纯噪音（一堆空 div），
 * 但「正在加载」这件事本身要说出来，否则用读屏的人只会听到一片寂静。
 */
export function SkeletonBoard({ label = '正在读取…' }: { label?: string }) {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      <SkeletonTitle w={96} />
      <SkeletonTable cols={7} rows={5} />
      <div style={{ marginTop: 12, display: 'grid', gap: 10 }}>
        <SkeletonCard lines={1} title={false} />
        <SkeletonCard lines={1} title={false} />
      </div>
    </div>
  );
}
