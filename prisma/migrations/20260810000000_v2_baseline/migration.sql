-- ★ 2026-08-14 手工补三列 ★
-- Persona.activeForces / Persona.naForces / Score.scoreRuleVersion 是当天加进 schema.prisma 的，
-- 而本文件是 8 月 10 日用 `prisma migrate diff --from-empty` 生成的，没跟上。
-- 云端建表只跑一次本文件，缺列的后果是 seed 写 activeForces 时直接报错、整个 bootstrap 失败。
--
-- 三列的写法与 schema.prisma 的声明一一对应，默认值也照抄，未改动其它任何语句：
--   activeForces  Json   @default("[]")                      -> JSONB NOT NULL DEFAULT '[]'
--   naForces      Json   @default("[]")                      -> JSONB NOT NULL DEFAULT '[]'
--   scoreRuleVersion String @default("v1_forces_hardcoded")   -> TEXT  NOT NULL DEFAULT '...'
--
-- ★ 以后再改 schema 别再手工补 ★ 在能跑 prisma 的机器上重新生成：
--   npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > prisma/init.sql

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('TRAINEE', 'MANAGER', 'ADMIN');

-- CreateEnum
CREATE TYPE "SessionType" AS ENUM ('INQUIRY', 'FOLLOWUP');

-- CreateEnum
CREATE TYPE "SessionMode" AS ENUM ('DRILL', 'EXAM');

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('ACTIVE', 'ENDED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'TRAINEE',
    "passwordHash" TEXT,
    "disabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamAttempt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
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
CREATE TABLE "Persona" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tests" TEXT NOT NULL,
    "sessionType" "SessionType" NOT NULL,
    "difficulty" TEXT NOT NULL,
    "activeForces" JSONB NOT NULL DEFAULT '[]',
    "naForces" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "Persona_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonaVariant" (
    "id" TEXT NOT NULL,
    "personaId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "openCard" JSONB NOT NULL,
    "hiddenCard" JSONB NOT NULL,
    "product" JSONB NOT NULL,
    "distractors" JSONB NOT NULL,
    "initState" JSONB NOT NULL,
    "exitLines" JSONB NOT NULL,
    "quoteReactions" JSONB NOT NULL,
    "languageStyle" TEXT NOT NULL,
    "presetElements" JSONB NOT NULL DEFAULT '[]',
    "examOnly" BOOLEAN NOT NULL DEFAULT false,

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

-- CreateIndex
CREATE UNIQUE INDEX "User_code_key" ON "User"("code");

-- CreateIndex
CREATE UNIQUE INDEX "ExamAttempt_userId_day_key" ON "ExamAttempt"("userId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "Persona_code_key" ON "Persona"("code");

-- CreateIndex
CREATE UNIQUE INDEX "PersonaVariant_variantId_key" ON "PersonaVariant"("variantId");

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

-- AddForeignKey
ALTER TABLE "ExamAttempt" ADD CONSTRAINT "ExamAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonaVariant" ADD CONSTRAINT "PersonaVariant_personaId_fkey" FOREIGN KEY ("personaId") REFERENCES "Persona"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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

