-- v1.1《实习期业务员训练与询盘准入方案》：期别 + 每晚滚动结算。
-- 兼容式迁移：只增枚举/列/表，不删任何历史数据，v3.0 的 InquiryAccessStatus 全部保留。
-- 历史实习账号按当前询盘权限映射一次初值：ACTIVE/PROVISIONAL → 在岗期，其余 → 训练期。

-- CreateEnum
CREATE TYPE "Stage" AS ENUM ('TRAINING', 'ACTIVE');

-- AlterEnum
ALTER TYPE "AttemptType" ADD VALUE 'DAILY';

-- AlterTable
ALTER TABLE "User" ADD COLUMN "stage" "Stage" NOT NULL DEFAULT 'TRAINING',
  ADD COLUMN "stageOverride" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "stageSetBy" "AccessSetBy" NOT NULL DEFAULT 'SYSTEM',
  ADD COLUMN "stageSetAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- 期别初值：只动实习业务员，正式业务员与待确认账号不受本方案约束（方案适用范围）
UPDATE "User"
SET "stage" = 'ACTIVE'
WHERE "employeeType" = 'INTERN'
  AND "inquiryAccessStatus" IN ('ACTIVE', 'PROVISIONAL');

-- 人工覆盖沿用：v3.0 里 accessSetBy = MANAGER 且覆盖未到期的，转成 v1.1 的布尔锁
UPDATE "User"
SET "stageOverride" = true, "stageSetBy" = 'MANAGER'
WHERE "employeeType" = 'INTERN'
  AND "accessSetBy" = 'MANAGER'
  AND "overrideUntil" IS NOT NULL
  AND "overrideUntil" > NOW();

-- CreateTable
CREATE TABLE "DailyEvaluation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "effectiveDay" TEXT NOT NULL,
    "sessionIds" TEXT[],
    "sampleCount" INTEGER NOT NULL,
    "preciseCount" INTEGER NOT NULL,
    "medianScore" DOUBLE PRECISION,
    "insightMedian" DOUBLE PRECISION,
    "answerMedian" DOUBLE PRECISION,
    "scoreOk" BOOLEAN NOT NULL DEFAULT false,
    "insightOk" BOOLEAN NOT NULL DEFAULT false,
    "redlineOk" BOOLEAN NOT NULL DEFAULT false,
    "answerOk" BOOLEAN NOT NULL DEFAULT false,
    "passed" BOOLEAN,
    "detail" JSONB NOT NULL,
    "consecutiveFails" INTEGER NOT NULL DEFAULT 0,
    "stageBefore" "Stage" NOT NULL,
    "recommendedStage" "Stage" NOT NULL,
    "appliedStage" "Stage" NOT NULL,
    "overrideActive" BOOLEAN NOT NULL DEFAULT false,
    "banner" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyEvaluation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DailyEvaluation_userId_day_key" ON "DailyEvaluation"("userId", "day");

-- CreateIndex
CREATE INDEX "DailyEvaluation_userId_day_idx" ON "DailyEvaluation"("userId", "day");

-- AddForeignKey
ALTER TABLE "DailyEvaluation" ADD CONSTRAINT "DailyEvaluation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
