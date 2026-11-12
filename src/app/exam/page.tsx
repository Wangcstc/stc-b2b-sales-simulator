import AppShell from '@/components/AppShell';
import ExamClient from './ExamClient';
import AdmissionPanel from '@/components/AdmissionPanel';
import EvaluationTable from '@/components/EvaluationTable';
import { requireUser } from '@/lib/current-user';
import { examTrackOf } from '@/lib/exam-track';
import WeeklyExamTable from '@/components/WeeklyExamTable';

export const dynamic = 'force-dynamic';

/**
 * 考试闸门。
 *
 * ★ 2026-08-23 王老师定：这一页只做操作提醒，不解释规则 ★
 * 之前这一页从上到下是：训练期大卡（期别、解锁进度、准入判定）→ 我的判定记录
 * → 状态屏四格 → 判定窗口 → 开考卡。**同一件事说了三遍**：
 * 「训练期」「今日 0/3 局」「昨天整天缺考」在上面的大卡里有、在状态屏里有、
 * 在判定窗口那句话里还有。加上每一处都挂着两三行解释，一屏读下来全是字。
 *
 * 现在分工：
 *   · 结算横幅 —— 昨晚判完、今天生效的那一条，是通知，留着
 *   · 状态屏（ExamClient）—— 今天能不能考、考到哪一步，一屏看完
 *   · 规则 —— 全部在「考前必读」，这一页一个字都不重复
 *
 * ★ 训练期大卡（AdmissionPanel 的下半截）不在这一页出现 ★ 它是首页的东西，
 * 首页没有状态屏，那里需要它；这一页有状态屏，再放一次就是同一件事说两遍。
 */
export default async function Page() {
  const user = await requireUser();
  /**
   * ★ 2026-08-24：两条轨都进得来 ★
   * 准入轨（实习业务员）：结算横幅 + 状态屏 + 每日判定表；
   * 周考轨（正式业务员）：状态屏 + 周考台账。
   * 状态屏（ExamClient）两条轨共用——开考按钮本来就是同一个。
   */
  const track = examTrackOf(user);
  const intern = track === 'ADMISSION';
  const weekly = track === 'WEEKLY';
  return (
    <AppShell current="/exam">
      {/* 昨晚判完、今天生效的那一条通知。没有就整块不出现 */}
      {intern && <AdmissionPanel user={user} bannerOnly />}
      {/* ★ 周考进度卡已于 2026-08-27 从这一页删除 ★
          它摆在状态屏上面，说的是「本周 8月24日–8月30日 · 每周至少 2 场（6 局）·
          本周中位数」——而这四件事状态屏里一件不落全有：
            · 周期范围   → 右下角那格「本周 · 08-24 至 08-30」
            · 每周几场   → 页头副标题 + KPI 第一格「本周考试 0/2 场」
            · 本周中位数 → KPI 第四格「本周 6 局考试中位数」
          更荒唐的是它右边挂着一个「去考试闸门」按钮，而这里**就是**考试闸门。
          ★ 补账没丢 ★ 那句 catchUpWeeks 原本搭在这个组件上，
          但 /api/exam 自己也补（route.ts 里 `if (weekly) await catchUpWeeks`），
          状态屏的数据就是从那个接口来的，删掉不影响周结算。
          ★ 首页那张还在 ★ 首页没有状态屏，那里才是它该待的地方。 */}

      <ExamClient />

      {intern && (
        <div className="section-block">
          <div className="section-title">我的每日判定</div>
          {/* ★ 只有自己 ★ 方案第三节：不做排行榜，也看不到别人的存在 */}
          <EvaluationTable userId={user.id} />
        </div>
      )}

      {weekly && (
        <div className="section-block">
          <div className="section-title">我的周考记录</div>
          {/* 同上：只有自己。周考也不做排行榜 */}
          <WeeklyExamTable userId={user.id} />
        </div>
      )}
    </AppShell>
  );
}
