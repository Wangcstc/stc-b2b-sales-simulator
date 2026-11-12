-- 从空库建出全部 24 张表。**这是全新部署走的路**（/api/admin/bootstrap 会读它）。
--
-- ★ 别手工补 ★ 改了 schema 就整份重新生成：
--     npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > prisma/init.sql
--   生成完把这段说明贴回文件头——migrate diff 只输出 SQL，不带任何注释。
--   缺表不会在建表时报错，会等到有人打开对应页面才炸，所以每次改 schema 都要重新生成。
--
-- ★ 它不替代迁移 ★ 这份只管「空库建全套」。已有数据的库要上新表，得走
-- `prisma migrate deploy`。

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('TRAINEE', 'MANAGER', 'ADMIN');

-- CreateEnum
CREATE TYPE "EmployeeType" AS ENUM ('INTERN', 'REGULAR', 'MANAGER', 'OTHER');

-- CreateEnum
CREATE TYPE "ParticipationMode" AS ENUM ('ADMISSION', 'WEEKLY_EXAM', 'NONE');

-- CreateEnum
CREATE TYPE "InquiryAccessStatus" AS ENUM ('NOT_ADMITTED', 'PROVISIONAL', 'ACTIVE', 'PAUSED', 'NOT_APPLICABLE');

-- CreateEnum
CREATE TYPE "AccessSetBy" AS ENUM ('SYSTEM', 'MANAGER');

-- CreateEnum
CREATE TYPE "Stage" AS ENUM ('TRAINING', 'ACTIVE');

-- CreateEnum
CREATE TYPE "PoolType" AS ENUM ('DRILL', 'ADMISSION_EXAM');

-- CreateEnum
CREATE TYPE "AttemptType" AS ENUM ('LEGACY', 'DAILY', 'ADMISSION_1', 'ADMISSION_2', 'MAINTENANCE', 'RETEST');

-- CreateEnum
CREATE TYPE "TrainingTaskStatus" AS ENUM ('PENDING', 'UNLOCKED', 'COMPLETED', 'INVALID');

-- CreateEnum
CREATE TYPE "TrainingTaskType" AS ENUM ('BASELINE', 'REMEDIAL', 'RECOVERY');

-- CreateEnum
CREATE TYPE "TrainingSlotType" AS ENUM ('SIMPLE_INQUIRY', 'STANDARD_INQUIRY', 'HARD_INQUIRY', 'FOLLOWUP');

-- CreateEnum
CREATE TYPE "SessionType" AS ENUM ('INQUIRY', 'FOLLOWUP');

-- CreateEnum
CREATE TYPE "SessionMode" AS ENUM ('DRILL', 'EXAM', 'ADMISSION_EXAM');

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('ACTIVE', 'ENDED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'TRAINEE',
    "passwordHash" TEXT,
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "disabledAt" TIMESTAMP(3),
    "employeeType" "EmployeeType" NOT NULL DEFAULT 'OTHER',
    "participationMode" "ParticipationMode" NOT NULL DEFAULT 'NONE',
    "inquiryAccessStatus" "InquiryAccessStatus" NOT NULL DEFAULT 'NOT_APPLICABLE',
    "accessSetBy" "AccessSetBy" NOT NULL DEFAULT 'SYSTEM',
    "accessSetAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accessEffectiveDay" TEXT,
    "overrideUntil" TIMESTAMP(3),
    "overrideReason" TEXT,
    "trainingStartDay" TEXT,
    "identityConfirmedAt" TIMESTAMP(3),
    "stage" "Stage" NOT NULL DEFAULT 'TRAINING',
    "stageOverride" BOOLEAN NOT NULL DEFAULT false,
    "stageSetBy" "AccessSetBy" NOT NULL DEFAULT 'SYSTEM',
    "stageSetAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessCalendar" (
    "day" TEXT NOT NULL,
    "isWorkday" BOOLEAN NOT NULL,
    "label" TEXT,
    "setBy" TEXT,
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BusinessCalendar_pkey" PRIMARY KEY ("day")
);

-- CreateTable
CREATE TABLE "LeaveDay" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "reason" TEXT,
    "setBy" TEXT,
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeaveDay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminAudit" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" TEXT NOT NULL,
    "subjectId" TEXT,
    "action" TEXT NOT NULL,
    "before" TEXT,
    "after" TEXT,
    "note" TEXT,

    CONSTRAINT "AdminAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DifficultyProfile" (
    "id" TEXT NOT NULL,
    "factor" DOUBLE PRECISION NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "setBy" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DifficultyProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamAttempt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "attemptType" "AttemptType" NOT NULL DEFAULT 'LEGACY',
    "businessDay" TEXT,
    "groupNo" INTEGER,
    "scoreRuleVersion" TEXT NOT NULL DEFAULT 'legacy_pre_v3',
    "poolVersion" TEXT NOT NULL DEFAULT 'legacy',
    "validSessionCount" INTEGER,
    "failedRules" JSONB,
    "gateResults" JSONB,
    "trainingCycleId" TEXT,
    "sessionIds" TEXT[],
    "medianScore" INTEGER,
    "minInsight" INTEGER,
    "anyRedline" BOOLEAN,
    "medianAnswerQuality" INTEGER,
    "passed" BOOLEAN,
    "verdict" TEXT,
    "conclusion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExamAttempt_pkey" PRIMARY KEY ("id")
);

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

-- CreateTable
CREATE TABLE "Persona" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tests" TEXT NOT NULL,
    "sessionType" "SessionType" NOT NULL,
    "difficulty" TEXT NOT NULL,
    "activeForces" JSONB NOT NULL DEFAULT '[]',
    "naForces" JSONB NOT NULL DEFAULT '[]',
    "syllabus" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "Persona_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankVersion" (
    "id" TEXT NOT NULL,
    "bankId" TEXT NOT NULL,
    "bankVersion" TEXT NOT NULL,
    "formatVersion" INTEGER NOT NULL,
    "syllabusVersion" INTEGER NOT NULL,
    "drawerVersion" TEXT NOT NULL,
    "generator" TEXT,
    "packedAt" TIMESTAMP(3) NOT NULL,
    "loadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fingerprint" TEXT NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "manifest" JSONB NOT NULL,
    "coverage" JSONB NOT NULL,

    CONSTRAINT "BankVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonaVariant" (
    "id" TEXT NOT NULL,
    "personaId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "bankVersionId" TEXT,
    "enabledInBank" BOOLEAN NOT NULL DEFAULT true,
    "openCard" JSONB NOT NULL,
    "hiddenCard" JSONB NOT NULL,
    "product" JSONB NOT NULL,
    "distractors" JSONB NOT NULL,
    "initState" JSONB NOT NULL,
    "exitLines" JSONB NOT NULL,
    "quoteReactions" JSONB NOT NULL,
    "languageStyle" TEXT NOT NULL,
    "presetElements" JSONB NOT NULL DEFAULT '[]',
    "difficulty" TEXT,
    "examOnly" BOOLEAN NOT NULL DEFAULT false,
    "poolType" "PoolType" NOT NULL DEFAULT 'DRILL',
    "poolVersion" TEXT NOT NULL DEFAULT 'v3.0',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "PersonaVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BgPackage" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "aiReport" JSONB NOT NULL,
    "website" JSONB NOT NULL,
    "social" JSONB NOT NULL,
    "contacts" JSONB NOT NULL,

    CONSTRAINT "BgPackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "drillId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "type" "SessionType" NOT NULL DEFAULT 'INQUIRY',
    "mode" "SessionMode" NOT NULL DEFAULT 'DRILL',
    "status" "SessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "exitReason" TEXT,
    "state" JSONB NOT NULL,
    "unlockState" JSONB NOT NULL,
    "facts" JSONB NOT NULL,
    "lockedAt" TIMESTAMP(3),
    "difficultyFactor" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "turn" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "extraction" JSONB,
    "stateSnapshot" JSONB,
    "leakBlocked" JSONB,
    "clientMsgId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Score" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "forces" JSONB NOT NULL,
    "coverage" DOUBLE PRECISION NOT NULL,
    "evaluableCount" INTEGER NOT NULL,
    "precise" BOOLEAN NOT NULL,
    "rawScore" INTEGER,
    "baselineScore" INTEGER,
    "tier" TEXT,
    "progress" INTEGER,
    "answerQuality" INTEGER,
    "flags" JSONB NOT NULL,
    "reportMd" TEXT,
    "scoreRuleVersion" TEXT NOT NULL DEFAULT 'v1_forces_hardcoded',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Score_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoachQa" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "idx" INTEGER NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT,
    "followUp" TEXT,
    "followUpAnswer" TEXT,
    "skipped" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoachQa_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Calibration" (
    "id" TEXT NOT NULL,
    "scenario" TEXT NOT NULL,
    "shouldBe" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Calibration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScoreCalibration" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "systemTier" TEXT,
    "humanTier" TEXT,
    "forces" JSONB NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScoreCalibration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RedlineReview" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "attemptId" TEXT,
    "redline" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "evidence" JSONB,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RedlineReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LlmCall" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT,
    "purpose" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptTokens" INTEGER NOT NULL,
    "completionTokens" INTEGER NOT NULL,
    "cacheHitTokens" INTEGER NOT NULL,
    "reasoningTokens" INTEGER NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LlmCall_pkey" PRIMARY KEY ("id")
);

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

-- CreateTable
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

-- CreateTable
CREATE TABLE "LoginEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL DEFAULT 'SIGN_IN',

    CONSTRAINT "LoginEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuestionFeedback" (
    "id" TEXT NOT NULL,
    "bankId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "note" TEXT,
    "sessionsAtDecision" INTEGER NOT NULL,
    "decidedById" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuestionFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_code_key" ON "User"("code");

-- CreateIndex
CREATE INDEX "BusinessCalendar_day_isWorkday_idx" ON "BusinessCalendar"("day", "isWorkday");

-- CreateIndex
CREATE INDEX "LeaveDay_day_idx" ON "LeaveDay"("day");

-- CreateIndex
CREATE UNIQUE INDEX "LeaveDay_userId_day_key" ON "LeaveDay"("userId", "day");

-- CreateIndex
CREATE INDEX "AdminAudit_at_idx" ON "AdminAudit"("at");

-- CreateIndex
CREATE INDEX "AdminAudit_subjectId_at_idx" ON "AdminAudit"("subjectId", "at");

-- CreateIndex
CREATE INDEX "DifficultyProfile_effectiveFrom_idx" ON "DifficultyProfile"("effectiveFrom");

-- CreateIndex
CREATE INDEX "ExamAttempt_userId_attemptType_businessDay_idx" ON "ExamAttempt"("userId", "attemptType", "businessDay");

-- CreateIndex
CREATE UNIQUE INDEX "ExamAttempt_userId_businessDay_attemptType_key" ON "ExamAttempt"("userId", "businessDay", "attemptType");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingTask_sessionId_key" ON "TrainingTask"("sessionId");

-- CreateIndex
CREATE INDEX "TrainingTask_userId_cycleId_status_idx" ON "TrainingTask"("userId", "cycleId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingTask_userId_cycleId_orderNo_key" ON "TrainingTask"("userId", "cycleId", "orderNo");

-- CreateIndex
CREATE INDEX "AccessDecision_subjectId_createdAt_idx" ON "AccessDecision"("subjectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Persona_code_key" ON "Persona"("code");

-- CreateIndex
CREATE UNIQUE INDEX "BankVersion_bankId_bankVersion_key" ON "BankVersion"("bankId", "bankVersion");

-- CreateIndex
CREATE INDEX "PersonaVariant_variantId_idx" ON "PersonaVariant"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "PersonaVariant_bankVersionId_variantId_key" ON "PersonaVariant"("bankVersionId", "variantId");

-- CreateIndex
CREATE UNIQUE INDEX "BgPackage_variantId_key" ON "BgPackage"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_drillId_key" ON "Session"("drillId");

-- CreateIndex
CREATE INDEX "Message_sessionId_turn_idx" ON "Message"("sessionId", "turn");

-- CreateIndex
CREATE UNIQUE INDEX "Message_sessionId_clientMsgId_key" ON "Message"("sessionId", "clientMsgId");

-- CreateIndex
CREATE UNIQUE INDEX "Score_sessionId_key" ON "Score"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "CoachQa_sessionId_idx_key" ON "CoachQa"("sessionId", "idx");

-- CreateIndex
CREATE UNIQUE INDEX "ScoreCalibration_sessionId_key" ON "ScoreCalibration"("sessionId");

-- CreateIndex
CREATE INDEX "RedlineReview_status_idx" ON "RedlineReview"("status");

-- CreateIndex
CREATE UNIQUE INDEX "RedlineReview_sessionId_redline_key" ON "RedlineReview"("sessionId", "redline");

-- CreateIndex
CREATE INDEX "LlmCall_sessionId_idx" ON "LlmCall"("sessionId");

-- CreateIndex
CREATE INDEX "DailyEvaluation_userId_day_idx" ON "DailyEvaluation"("userId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "DailyEvaluation_userId_day_key" ON "DailyEvaluation"("userId", "day");

-- CreateIndex
CREATE INDEX "WeeklyExamRecord_userId_weekStart_idx" ON "WeeklyExamRecord"("userId", "weekStart");

-- CreateIndex
CREATE UNIQUE INDEX "WeeklyExamRecord_userId_weekStart_key" ON "WeeklyExamRecord"("userId", "weekStart");

-- CreateIndex
CREATE INDEX "LoginEvent_userId_at_idx" ON "LoginEvent"("userId", "at");

-- CreateIndex
CREATE INDEX "LoginEvent_at_idx" ON "LoginEvent"("at");

-- CreateIndex
CREATE INDEX "QuestionFeedback_bankId_variantId_idx" ON "QuestionFeedback"("bankId", "variantId");

-- AddForeignKey
ALTER TABLE "LeaveDay" ADD CONSTRAINT "LeaveDay_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminAudit" ADD CONSTRAINT "AdminAudit_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminAudit" ADD CONSTRAINT "AdminAudit_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DifficultyProfile" ADD CONSTRAINT "DifficultyProfile_setBy_fkey" FOREIGN KEY ("setBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamAttempt" ADD CONSTRAINT "ExamAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingTask" ADD CONSTRAINT "TrainingTask_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingTask" ADD CONSTRAINT "TrainingTask_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessDecision" ADD CONSTRAINT "AccessDecision_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessDecision" ADD CONSTRAINT "AccessDecision_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonaVariant" ADD CONSTRAINT "PersonaVariant_personaId_fkey" FOREIGN KEY ("personaId") REFERENCES "Persona"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonaVariant" ADD CONSTRAINT "PersonaVariant_bankVersionId_fkey" FOREIGN KEY ("bankVersionId") REFERENCES "BankVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BgPackage" ADD CONSTRAINT "BgPackage_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "PersonaVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "PersonaVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Score" ADD CONSTRAINT "Score_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoachQa" ADD CONSTRAINT "CoachQa_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScoreCalibration" ADD CONSTRAINT "ScoreCalibration_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RedlineReview" ADD CONSTRAINT "RedlineReview_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RedlineReview" ADD CONSTRAINT "RedlineReview_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyEvaluation" ADD CONSTRAINT "DailyEvaluation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeeklyExamRecord" ADD CONSTRAINT "WeeklyExamRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoginEvent" ADD CONSTRAINT "LoginEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionFeedback" ADD CONSTRAINT "QuestionFeedback_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

