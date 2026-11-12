-- v3.0 准入与正式员工校准：兼容式迁移，只增列/表/枚举，不删除历史业务数据。
-- 旧 EXAM 会话与旧 ExamAttempt 保留为 LEGACY，不进入新版准入窗口。

-- CreateEnum
CREATE TYPE "EmployeeType" AS ENUM ('INTERN', 'REGULAR', 'OTHER');

-- CreateEnum
CREATE TYPE "ParticipationMode" AS ENUM ('ADMISSION', 'CALIBRATION', 'NONE');

-- CreateEnum
CREATE TYPE "InquiryAccessStatus" AS ENUM ('NOT_ADMITTED', 'PROVISIONAL', 'ACTIVE', 'PAUSED', 'NOT_APPLICABLE');

-- CreateEnum
CREATE TYPE "AccessSetBy" AS ENUM ('SYSTEM', 'MANAGER');

-- CreateEnum
CREATE TYPE "PoolType" AS ENUM ('DRILL', 'ADMISSION_EXAM', 'CALIBRATION');

-- CreateEnum
CREATE TYPE "AttemptType" AS ENUM ('LEGACY', 'ADMISSION_1', 'ADMISSION_2', 'MAINTENANCE', 'RETEST');

-- CreateEnum
CREATE TYPE "TrainingTaskStatus" AS ENUM ('PENDING', 'UNLOCKED', 'COMPLETED', 'INVALID');

-- CreateEnum
CREATE TYPE "TrainingTaskType" AS ENUM ('BASELINE', 'REMEDIAL', 'RECOVERY');

-- CreateEnum
CREATE TYPE "TrainingSlotType" AS ENUM ('SIMPLE_INQUIRY', 'STANDARD_INQUIRY', 'HARD_INQUIRY', 'FOLLOWUP');

-- CreateEnum
CREATE TYPE "CalibrationTaskStatus" AS ENUM ('PENDING', 'COMPLETED', 'DEFERRED', 'INVALID');

-- CreateEnum
CREATE TYPE "CalibrationTaskType" AS ENUM ('BASELINE', 'SCALE_CALIBRATION');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "SessionMode" ADD VALUE 'ADMISSION_EXAM';
ALTER TYPE "SessionMode" ADD VALUE 'CALIBRATION';

-- DropIndex
DROP INDEX "ExamAttempt_userId_day_key";

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "accessEffectiveDay" TEXT,
ADD COLUMN     "accessSetAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "accessSetBy" "AccessSetBy" NOT NULL DEFAULT 'SYSTEM',
ADD COLUMN     "calibrationCycleId" TEXT,
ADD COLUMN     "employeeType" "EmployeeType" NOT NULL DEFAULT 'OTHER',
ADD COLUMN     "inquiryAccessStatus" "InquiryAccessStatus" NOT NULL DEFAULT 'NOT_APPLICABLE',
ADD COLUMN     "overrideReason" TEXT,
ADD COLUMN     "overrideUntil" TIMESTAMP(3),
ADD COLUMN     "participationMode" "ParticipationMode" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "trainingStartDay" TEXT;

-- AlterTable
ALTER TABLE "ExamAttempt" ADD COLUMN     "attemptType" "AttemptType" NOT NULL DEFAULT 'LEGACY',
ADD COLUMN     "businessDay" TEXT,
ADD COLUMN     "failedRules" JSONB,
ADD COLUMN     "gateResults" JSONB,
ADD COLUMN     "groupNo" INTEGER,
ADD COLUMN     "poolVersion" TEXT NOT NULL DEFAULT 'legacy',
ADD COLUMN     "scoreRuleVersion" TEXT NOT NULL DEFAULT 'legacy_pre_v3',
ADD COLUMN     "trainingCycleId" TEXT,
ADD COLUMN     "validSessionCount" INTEGER;

-- AlterTable
ALTER TABLE "PersonaVariant" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "poolType" "PoolType" NOT NULL DEFAULT 'DRILL',
ADD COLUMN     "poolVersion" TEXT NOT NULL DEFAULT 'v3.0',
ADD COLUMN     "retiredAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "TrainingTask" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "orderNo" INTEGER NOT NULL,
    "taskType" "TrainingTaskType" NOT NULL DEFAULT 'BASELINE',
    "slotType" "TrainingSlotType" NOT NULL,
    "requiresBg" BOOLEAN NOT NULL DEFAULT false,
    "skeletonCode" TEXT,
    "sessionId" TEXT,
    "status" "TrainingTaskStatus" NOT NULL DEFAULT 'PENDING',
    "sourceAttemptId" TEXT,
    "reason" TEXT,
    "dueAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrainingTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalibrationTask" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "weekNo" INTEGER NOT NULL,
    "orderNo" INTEGER NOT NULL,
    "taskType" "CalibrationTaskType" NOT NULL,
    "slotType" "TrainingSlotType" NOT NULL,
    "sessionId" TEXT,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "status" "CalibrationTaskStatus" NOT NULL DEFAULT 'PENDING',
    "scoreRuleVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalibrationTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccessDecision" (
    "id" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "attemptIds" TEXT[],
    "gateResults" JSONB NOT NULL,
    "recommendedStatus" "InquiryAccessStatus" NOT NULL,
    "appliedStatus" "InquiryAccessStatus" NOT NULL,
    "manualOverride" BOOLEAN NOT NULL DEFAULT false,
    "operatorId" TEXT,
    "reason" TEXT,
    "effectiveDay" TEXT NOT NULL,
    "overrideUntil" TIMESTAMP(3),
    "poolVersion" TEXT NOT NULL,
    "scoreRuleVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccessDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TrainingTask_sessionId_key" ON "TrainingTask"("sessionId");

-- CreateIndex
CREATE INDEX "TrainingTask_userId_cycleId_status_idx" ON "TrainingTask"("userId", "cycleId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingTask_userId_cycleId_orderNo_key" ON "TrainingTask"("userId", "cycleId", "orderNo");

-- CreateIndex
CREATE UNIQUE INDEX "CalibrationTask_sessionId_key" ON "CalibrationTask"("sessionId");

-- CreateIndex
CREATE INDEX "CalibrationTask_userId_cycleId_status_idx" ON "CalibrationTask"("userId", "cycleId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CalibrationTask_userId_cycleId_orderNo_key" ON "CalibrationTask"("userId", "cycleId", "orderNo");

-- CreateIndex
CREATE INDEX "AccessDecision_subjectId_createdAt_idx" ON "AccessDecision"("subjectId", "createdAt");

-- CreateIndex
CREATE INDEX "ExamAttempt_userId_attemptType_businessDay_idx" ON "ExamAttempt"("userId", "attemptType", "businessDay");

-- CreateIndex
CREATE UNIQUE INDEX "ExamAttempt_userId_businessDay_attemptType_key" ON "ExamAttempt"("userId", "businessDay", "attemptType");

-- AddForeignKey
ALTER TABLE "TrainingTask" ADD CONSTRAINT "TrainingTask_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingTask" ADD CONSTRAINT "TrainingTask_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalibrationTask" ADD CONSTRAINT "CalibrationTask_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalibrationTask" ADD CONSTRAINT "CalibrationTask_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessDecision" ADD CONSTRAINT "AccessDecision_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessDecision" ADD CONSTRAINT "AccessDecision_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Data migration: keep old exams auditable while isolating them from v3.0 admission.
UPDATE "ExamAttempt"
SET "businessDay" = "day",
    "attemptType" = 'LEGACY',
    "scoreRuleVersion" = 'legacy_pre_v3',
    "poolVersion" = 'legacy';

-- Data migration: translate the old two-pool flag into the v3.0 three-pool field.
UPDATE "PersonaVariant"
SET "poolType" = CASE WHEN "examOnly" THEN 'ADMISSION_EXAM'::"PoolType" ELSE 'DRILL'::"PoolType" END,
    "poolVersion" = CASE
      WHEN "examOnly" THEN 'v3.0-admission-20260815'
      ELSE 'v3.0-drill-20260815'
    END;
