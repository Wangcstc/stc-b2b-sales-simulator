import Link from 'next/link';
import { businessDay } from '@/lib/business-day';
import { ADMISSION_CONFIG, fmt, unlockState } from '@/lib/admission-v11';
import { bannerForToday, catchUpSettlement, countDrillsToday, previewWindow } from '@/lib/settlement';
import type { CurrentUser } from '@/lib/current-user';
import Icon from './Icon';

/**
 * 实习业务员首页三件套（方案 9.1 / 9.2 / 9.4）
 *
 * ① 结算横幅——昨晚判完、今天生效的那一条
 * ② 解锁进度卡——只有训练期显示
 * ③ 状态条——两期都显示
 *
 * ★ 9.6：被人工覆盖时，这里只显示当前状态，不显示「你被主管手动开的」★
 * 一告诉他，「我是被特批的」就会变成他心里的标签，而这个标签既不准确
 * （主管的理由他不知道），也没有用（他能做的仍然只有把分打上去）。
 * 但**分数照常显示、距离照常显示**——那才是他能行动的部分。
 */

const WINDOW = ADMISSION_CONFIG.windowSessions;

/**
 * 样本不够时一句话说清缺在哪。
 * ★ 只说事实，不带规则 ★ 「缺的局补不回来」这类写在考前必读里。
 */
function missText(window: { missingByDay: Array<{ day: string; missing: number }>; sampleCount: number; preciseCount: number }): string {
  const today = businessDay();
  const missed = window.missingByDay.filter((item) => item.day !== today);
  const todayGap = window.missingByDay.find((item) => item.day === today);
  if (missed.length > 0) return `${missed.map((item) => item.day.slice(5)).join('、')} 缺考`;
  if (todayGap) return `今天还差 ${todayGap.missing} 局`;
  if (window.preciseCount < window.sampleCount) return '有局没评出分';
  return '样本没齐';
}

function Banner({ kind, median, gap }: { kind: string; median: string; gap: string }) {
  const box = (color: string, children: React.ReactNode) => (
    <div className="card section-block" style={{ borderColor: color, background: 'var(--panel-2)', borderLeftWidth: 3, borderLeftStyle: 'solid' }}>
      <div className="small" style={{ lineHeight: 1.9, whiteSpace: 'pre-line' }}>{children}</div>
    </div>
  );

  if (kind === 'GRANTED') {
    return box(
      'var(--ok)',
      <>
        <b className="with-ico" style={{ fontSize: 'var(--fs-base)' }}>
          <Icon name="award" size={16} />
          你已获得询盘接待准入资格
        </b>
        {`

最近 ${WINDOW} 局中位数 ${median}，已达标。
从今天起，主管会给你分配真实询盘。

资格是每天重算的：往后每天 1 场考试，最近 ${WINDOW} 局仍达标就保留。`}
      </>,
    );
  }
  if (kind === 'KEPT') {
    return box('var(--ok)', `最近 ${WINDOW} 局中位数 ${median} · 已达标 · 今日分配权正常`);
  }
  if (kind === 'WARNED') {
    return box(
      'var(--warn)',
      <>
        <b className="with-ico" style={{ fontSize: 'var(--fs-base)', color: 'var(--warn)' }}>
          <Icon name="alert" size={15} />
          {`最近 ${WINDOW} 局中位数 ${median}，距 ${ADMISSION_CONFIG.medianScoreMin} 差 ${gap} 分。`}
        </b>
        {`

再有一天不达标，明天起将暂停分配新询盘。
你手上的客户不受影响，照常跟进。`}
      </>,
    );
  }
  if (kind === 'SUSPENDED') {
    return box(
      'var(--bad)',
      <>
        <b style={{ fontSize: 'var(--fs-base)' }}>今日暂停分配新询盘，回到训练期。</b>
        {`

`}
        <b>★ 你手上已有的客户仍然是你的，跟进完全不受影响 ★</b>
        {`
暂停的只是「分配新询盘」这一项。

回来的路：今天起每天练够 ${ADMISSION_CONFIG.dailyDrillMin} 局解锁考试，
最近 ${WINDOW} 局中位数回到 ${ADMISSION_CONFIG.medianScoreMin}，次日恢复。`}
      </>,
    );
  }
  return null;
}

/**
 * @param bannerOnly 只出结算横幅，不出下面那张期别／进度／判定卡。
 *   ★ 2026-08-23 王老师定 ★ 考试闸门页有状态屏了，那张卡在那儿是同一件事说第二遍。
 *   首页没有状态屏，仍然要整块。
 */
export default async function AdmissionPanel({
  user,
  bannerOnly = false,
}: {
  user: CurrentUser;
  bannerOnly?: boolean;
}) {
  if (user.employeeType !== 'INTERN' || user.participationMode !== 'ADMISSION') return null;

  const today = businessDay();
  // 读页面顺手补算漏掉的结算。幂等，只处理已经过去的业务日。
  await catchUpSettlement(user.id, today);

  const [banner, drills, window] = await Promise.all([
    bannerForToday(user.id, today),
    countDrillsToday(user.id, today),
    previewWindow(user.id),
  ]);
  const unlock = unlockState(drills.done, user.stage, drills.nonSimple);
  const training = user.stage === 'TRAINING';

  return (
    <>
      {banner?.banner && (
        <Banner
          kind={banner.banner}
          median={fmt(banner.medianScore ?? 0)}
          gap={fmt(Math.max(0, ADMISSION_CONFIG.medianScoreMin - (banner.medianScore ?? 0)))}
        />
      )}

      {!bannerOnly && (
      <div className="card section-block" style={{ borderColor: 'var(--accent)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          <div>
            {/* ★ 这行字下面原来压着一整条规则 ★（2026-08-23 删）
                「每天练够 3 局解锁考试，最近 6 局中位数 ≥65 → 次日获得分配权」——
                那是规则，写在考前必读里；这张卡只说他现在在哪个期、今天还差几局。 */}
            <b>{training ? '训练期' : '在岗期 · 分配权正常'}</b>
            <div className="small muted" style={{ marginTop: 5 }}>
              {training ? '还没有新询盘分配权' : '新询盘分配权正常'}
            </div>
          </div>
          <Link href="/exam">
            <button className={unlock.unlocked ? 'primary' : ''} disabled={!unlock.unlocked}>
              {unlock.unlocked ? '去考试闸门' : `还差 ${unlock.required - unlock.done} 局解锁`}
            </button>
          </Link>
        </div>

        {/* ── 解锁进度卡：只有训练期显示（方案 9.1）──
            解锁了那圈绿是语义色，要留；没解锁不描边——外面那张卡已经框过一圈了 */}
        {training && (
          <div className="card" style={{ marginTop: 14, background: 'var(--panel-2)', borderColor: unlock.unlocked ? 'var(--ok)' : 'transparent' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <b className="small with-ico">
                <Icon name={unlock.unlocked ? 'check' : 'unlock'} size={14} />
                今日进度 {unlock.done} / {unlock.required} 局
              </b>
            </div>
            <div className="small muted" style={{ marginTop: 6, lineHeight: 1.8 }}>{unlock.text}</div>
          </div>
        )}

        {/* ── 状态条 ──
            ★ 只留一句现状 ★（2026-08-23 王老师定）原来这里是 statusLine() 的整段话，
            后面拖着三句规则（判定要几局、缺的局补不回来、连着考满两天才重新达标），
            外加一个装着三条口径的「?」。规则在考前必读里，这里只说他现在什么情况。 */}
        <div className="small" style={{ marginTop: 14 }}>
          <span className="section-label" style={{ margin: 0, marginRight: 8 }}>准入判定</span>
          {window.enough
            ? `最近 ${WINDOW} 局考试中位数 ${fmt(window.medianScore ?? 0)}` +
              (window.passed ? ' · 达标' : ` · 差 ${fmt(window.scoreGap)} 分`)
            : missText(window)}
        </div>
      </div>
      )}
    </>
  );
}
