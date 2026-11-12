import Link from 'next/link';
import AppShell from '@/components/AppShell';
import { requireUser, canSeeEveryone } from '@/lib/current-user';
import { examTrackOf } from '@/lib/exam-track';
import { anchorOf, HELP_PAGES, type HelpPage, type HelpSection } from '@/content/help';
import Icon from '@/components/Icon';
import RestoreGuideCards from './RestoreGuideCards';

export const dynamic = 'force-dynamic';

/**
 * 第 4 层：帮助中心（2026-08-27 新建）
 *
 * ★ 全站唯一一处帮助内容的落地页 ★
 * 抽屉解决的是「我正在这一页，这个字段什么意思」；这一页解决另外两件事：
 *   ① 通读——第一次上手的人想从头看一遍，不该逼他一页页点过去；
 *   ② 深链——「详见 /help#team-role」这种指路，全站都能用。
 *
 * ★ 内容一个字都不写在这儿 ★
 * 渲染的是 content/help/ 里那份，和抽屉读的是同一个 body()。
 * 这一页只管：谁该看哪几组、怎么排、目录长什么样。
 *
 * ★ 按角色分栏，不是全摊开 ★
 * 主管那套判定阈值对业务员一条都不成立，摊给他看只会让他以为自己也归那套管。
 */
export default async function HelpCenter() {
  const user = await requireUser();
  const track = examTrackOf(user);
  const lead = canSeeEveryone(user);

  // 能看哪几组：主管的那几组不给业务员；不走考试的人也不必看考试要求
  const visible = HELP_PAGES.filter((p) => {
    if (p.audience === 'lead' && !lead) return false;
    if (p.audience === 'staff' && track === null) return false;
    return true;
  })
    .map((p) => ({
      ...p,
      // 不适用的规则比没有规则更糟：只留这条轨该看的
      sections: p.sections.filter((s) => !s.only || s.only === track),
    }))
    // 整组被过滤空了就别画标题——空标题读起来像内容没加载出来
    .filter((p): p is HelpPage & { sections: [HelpSection, ...HelpSection[]] } => p.sections.length > 0);

  return (
    <AppShell current="/help">
      <div className="page-head">
        <h1>帮助中心</h1>
      </div>
      <p className="page-sub">
        全站的说明都在这一页。
        <b>不用从头读</b> —— 每一页右上角都有「这页怎么用」，在哪儿卡住就在哪儿点开，
        看到的是下面同一份内容。
      </p>

      {/* 顶部目录：这一页很长，没有它只能靠滚 */}
      <nav className="help-index section-block" aria-label="帮助中心目录">
        {visible.map((p) => (
          <div key={p.id} className="help-index-group">
            <a className="help-index-head" href={`#${anchorOf(p.id, p.sections[0].id)}`}>
              {p.title}
            </a>
            <div className="help-index-items">
              {p.sections.map((s) => (
                <a key={s.id} href={`#${anchorOf(p.id, s.id)}`}>
                  {s.title}
                </a>
              ))}
            </div>
          </div>
        ))}
      </nav>

      {visible.map((p) => (
        <Group key={p.id} page={p} track={track} />
      ))}

      <div className="card section-block" style={{ background: 'var(--panel-2)' }}>
        <div className="subsection-title" style={{ marginTop: 0 }}>还是没找着？</div>
        <div className="small" style={{ lineHeight: 1.9 }}>
          <div>· 页面里每个 <b>?</b> 都能点，气泡里是一句话，点「看完整说明」回到这份内容。</div>
          <div>· 手册全文在知识库的《新人使用说明》，这一页只收随手要查的规则。</div>
          <div style={{ marginTop: 10 }}>
            <RestoreGuideCards />
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function Group({ page, track }: { page: HelpPage; track: 'ADMISSION' | 'WEEKLY' | null }) {
  return (
    <section className="section-block">
      <div className="section-title">
        {page.title}
        {/* 说明和它讲的那一页要能互相走得通，不然读完还得自己找路 */}
        {page.route !== '/' && (
          <Link className="help-goto" href={page.route}>
            去这一页 <Icon name="target" size={12} />
          </Link>
        )}
      </div>
      <p className="small muted" style={{ marginTop: 6, lineHeight: 1.8, maxWidth: '68ch' }}>
        {page.intro}
      </p>

      {/* ★ 2026-08-28 去框 ★ 这一层包的是这一组的**全部**小节，
          而每个小节自己已经有 .help-sec 的标题与间距了——外面这圈框
          既分不出小节、也分不出组（组之间靠的是上面那个组标题）。 */}
      <div style={{ marginTop: 12 }}>
        {page.sections.map((s, i) => (
          <section
            key={s.id}
            id={anchorOf(page.id, s.id)}
            className="help-sec"
            style={i === 0 ? { marginTop: 0 } : undefined}
          >
            <h3>{s.title}</h3>
            <div className="help-body">{s.body({ track })}</div>
          </section>
        ))}
      </div>
    </section>
  );
}
