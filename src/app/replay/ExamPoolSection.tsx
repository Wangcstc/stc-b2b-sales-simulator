import Link from 'next/link';
import { prisma } from '@/lib/db';
import PagedList from '@/components/PagedList';
import Help from '@/components/Help';
import { EXAM_POOL_HEALTH, EXAM_SLOTS, EXAM_SLOT_LABEL, examSlotOf } from '@/lib/exam';
import { loadExamPoolHealth } from '@/lib/board';

/**
 * 教练台最下面那块「考试题库」。**从 page.tsx 抽出来只为一件事：能被 Suspense 包住。**
 *
 * ★ 它是折叠的，却在阻塞整页 ★ 这块默认收起（考题不能摊在业务员面前），
 * 可它那两个 personaVariant 查询是在页面主体里跑的——也就是说，
 * 主管每次打开教练台，都要等一块**他多半不会展开**的内容查完才能看见任何东西。
 * 抽成组件之后交给 Suspense：页面先出来，它自己在后面慢慢查。
 */
export default async function ExamPoolSection() {


  /**
   * 考试题库（主管专属）。
   *
   * ★ 为什么考题在别处一律不显示，这里却要显示 ★
   * 考题出现在首页、模拟询盘、开考前后的任何一处，都等于泄题——所以那些地方
   * 一律按 examOnly:false 过滤掉。但**出题人得能审题**：池子里到底有几套、
   * 三个槽位够不够轮换、哪一套还缺背调包。这些过去只能去翻题目 JSON，
   * 于是「考试池是空的」这件事才会瞒了那么久没人发现。
   *
   * ★ 只摆到「暗牌几张」为止，不摆暗牌内容 ★
   * 审题要看细节就去看 JSON。把暗牌摊在屏幕上，主管在工位打开被人扫一眼就漏了，
   * 而这一页本来就没有"关掉再看"的保护。
   */
  const examVariants = await prisma.personaVariant.findMany({
    where: { poolType: 'ADMISSION_EXAM', active: true },
    include: { persona: true, bgPackage: { select: { id: true } } },
    orderBy: { variantId: 'asc' },
  });
  // 同骨架的演习局：审题时最要紧的一条对照——这套考题是照着哪一局派生的
  const drillVariants = await prisma.personaVariant.findMany({
    where: { poolType: 'DRILL', active: true },
    select: { variantId: true, personaId: true },
  });
  /**
   * ★ 分档口径不再在这儿自己写一份 ★（2026-08-28）
   * 这里原来有个写在组件里的箭头函数，返回中文标签；开考那边另有一份返回枚举。
   * 两份逻辑一样、各自维护——改一处不改另一处，主管会看着一个说"够了"的面板，
   * 撞上一个说"不够"的报错。现在两边都读 `lib/exam.examSlotOf`。
   */
  const health = await loadExamPoolHealth();
  const bySlot = EXAM_SLOTS.map((slot) => ({
    slot,
    label: EXAM_SLOT_LABEL[slot],
    items: examVariants.filter((v) => examSlotOf(v.persona) === slot),
    stat: health.slots.find((item) => item.slot === slot)!,
  }));
  // 三个槽位相乘＝能排出多少种不同的三局考卷。任一槽位为 0，考试就开不成
  const comboCount = bySlot.reduce((acc, s) => acc * s.items.length, 1);


  // ★ 教练台提示（需求文档 5.1）★ 某个考试槽位不够开考时，在折叠框外面说一句，点进去直达题库工坊的覆盖页
  const short = bySlot.filter((s) => s.items.length < EXAM_POOL_HEALTH.minVariantsPerSlot || s.stat.personas < EXAM_POOL_HEALTH.minPersonasPerSlot);

  return (
    <>
        {short.length > 0 && (
          <div className="card small section-block" style={{ padding: '10px 16px', borderColor: 'color-mix(in srgb, var(--warn) 40%, transparent)' }}>
            考试池还不够开考：{short.map((s) => s.label).join('、')}题太少或题型太少。演习照常能练。
            <Link href="/workshop/coverage" style={{ marginLeft: 6 }}>到题库工坊看缺哪类题、找什么样的聊天补 →</Link>
          </div>
        )}
        <details className="card section-fold section-block" style={{ padding: '12px 16px' }}>
          <summary>
            考试题库
            <span className="sub">
              <span className="num">{examVariants.length}</span> 套 ·{' '}
              <span className="num">{comboCount}</span> 种组合 ·{' '}
              <b style={{ color: 'var(--warn)' }}>是考题，别在业务员面前打开</b>
            </span>
          </summary>

          <div style={{ marginTop: 12 }}>
            <Help topic="coach-exam-pool" label="这些题是怎么来的" />
          </div>

          {examVariants.length === 0 ? (
            <div className="card small" style={{ marginTop: 12, borderColor: 'var(--bad)', color: 'var(--bad)' }}>
              考试专用池是空的。这时开考会退回演习池，考的全是新人练过的题。
            </div>
          ) : (
            bySlot.map(({ slot, label, items, stat }) => (
              <div key={slot} style={{ marginTop: 14 }}>
                <div className="subsection-title" style={{ marginBottom: 6 }}>
                  {label}　<span className="num">{items.length}</span> 套
                  {items.length === 0 && <b style={{ color: 'var(--bad)', marginLeft: 8 }}>缺！这个槽位没题，考试开不成</b>}
                </div>
                {/* ★ 份数够 ≠ 池子够 ★（2026-08-28）真正决定会不会重复考点的是考点数：
                    14 份题可以全部来自 4 个考点，换了国家品类人名，要问的东西一个字没变。
                    抽题已经改成"先在考点里等概率"，但那只是把伤害摊平，治不了根。 */}
                <div className="tiny" style={{ marginBottom: 8 }}>
                  <span className={stat.personas >= EXAM_POOL_HEALTH.targetPersonasPerSlot ? 'faint' : ''}
                        style={stat.personas >= EXAM_POOL_HEALTH.targetPersonasPerSlot ? undefined : { color: 'var(--warn)' }}>
                    考点 <span className="num">{stat.personas}</span> 个
                    <span className="faint">（目标 ≥{EXAM_POOL_HEALTH.targetPersonasPerSlot}，下限 {EXAM_POOL_HEALTH.minPersonasPerSlot}）</span>
                  </span>
                  {stat.topPersona && (
                    <span style={{ marginLeft: 14,
                      color: stat.topPersona.share > EXAM_POOL_HEALTH.maxPersonaShare ? 'var(--warn)' : undefined }}
                      className={stat.topPersona.share > EXAM_POOL_HEALTH.maxPersonaShare ? '' : 'faint'}>
                      最大占比 <span className="mono">{stat.topPersona.code}</span>{' '}
                      <span className="num">{Math.round(stat.topPersona.share * 100)}</span>%
                      <span className="faint">（上限 {Math.round(EXAM_POOL_HEALTH.maxPersonaShare * 100)}%）</span>
                    </span>
                  )}
                </div>
                <PagedList>
                  {items.map((v) => {
                    const oc = v.openCard as { name?: string; country?: string; company?: string };
                    const cards = Object.keys((v.hiddenCard ?? {}) as Record<string, unknown>).length;
                    const sib = drillVariants.find((d) => d.personaId === v.personaId);
                    return (
                      /* .list-row 管行距与发丝线；这一行是两层内容，所以竖排 */
                      <div key={v.id} className="list-row" style={{ display: 'block' }}>
                        <div className="small">
                          <span className="mono faint">{v.variantId}</span>
                          <b style={{ marginLeft: 10 }}>{v.persona.name}</b>
                          <span className="muted" style={{ marginLeft: 10 }}>
                            {oc.name}（{oc.country}）· {oc.company}
                          </span>
                        </div>
                        <div className="tiny faint" style={{ marginTop: 4 }}>
                          考 {v.persona.tests} ｜ 暗牌 <span className="num">{cards}</span> 张 ｜ 背调包{' '}
                          {v.bgPackage ? '有' : '无'}
                          {sib && <> ｜ 同骨架的演习局 <span className="mono">{sib.variantId}</span></>}
                        </div>
                      </div>
                    );
                  })}
                </PagedList>
              </div>
            ))
          )}
        </details>
    </>
  );
}
