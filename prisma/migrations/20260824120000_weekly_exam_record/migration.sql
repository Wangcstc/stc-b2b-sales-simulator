-- 正式业务员的周考记录。一人一周一条。
--
-- ★ 2026-08-24 王老师定 ★ 正式业务员每周至少考 2 场（= 6 局出分），
-- 「这 6 局的考试分数出来之后，也同样像实习业务员那样记录在那里」。
--
-- ★ 只增一张表，不动任何既有数据、不改任何既有列 ★
-- 实习业务员那套 DailyEvaluation / stage / AccessDecision 一个字段都没碰——
-- 两套规则服务两种人，合表的话动一边就会顺手动到另一边。
--
-- ★ met 可空是有意的 ★ 三态：true=本周考够了；false=这一周已经过完但没考够；
-- NULL=这一周还没过完，**不构成结论**。周三就说人家「没考够」是拿没到期的账催人。

CREATE TABLE "WeeklyExamRecord" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "weekStart" TEXT NOT NULL,
    "weekEnd" TEXT NOT NULL,
    "sessionIds" TEXT[],
    "examCount" INTEGER NOT NULL,
    "sampleCount" INTEGER NOT NULL,
    "preciseCount" INTEGER NOT NULL,
    "medianScore" DOUBLE PRECISION,
    "met" BOOLEAN,
    "detail" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WeeklyExamRecord_pkey" PRIMARY KEY ("id")
);

-- 周结算每晚都跑，靠这个唯一键做幂等 upsert：同一周反复算，永远只有一行。
CREATE UNIQUE INDEX "WeeklyExamRecord_userId_weekStart_key" ON "WeeklyExamRecord"("userId", "weekStart");
CREATE INDEX "WeeklyExamRecord_userId_weekStart_idx" ON "WeeklyExamRecord"("userId", "weekStart");

-- RESTRICT：留了周考记录的人不许被硬删，与 AdminAudit / DailyEvaluation 同一口径。
ALTER TABLE "WeeklyExamRecord" ADD CONSTRAINT "WeeklyExamRecord_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
