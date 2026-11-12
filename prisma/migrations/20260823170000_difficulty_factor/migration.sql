-- 难度系数 α（王老师 2026-08-23 指令）
--
-- 两处改动，一次迁移：
--   1. Session.difficultyFactor —— 开局那一刻的系数快照。
--      默认 1.0，所以历史局全部落成"标准难度"，与它们当初实际跑的口径一致。
--   2. DifficultyProfile —— 系数的变更历史，只增不改。
--
-- 不建初始行：读不到任何生效记录时代码退回 1.0（见 lib/difficulty-setting.ts）。
-- 塞一行"2026-08-23 起 1.0"看着整齐，但会让"从没调过"和"调过又调回来"分不开。

ALTER TABLE "Session" ADD COLUMN "difficultyFactor" DOUBLE PRECISION NOT NULL DEFAULT 1.0;

CREATE TABLE "DifficultyProfile" (
    "id" TEXT NOT NULL,
    "factor" DOUBLE PRECISION NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "setBy" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DifficultyProfile_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DifficultyProfile_effectiveFrom_idx" ON "DifficultyProfile"("effectiveFrom");

ALTER TABLE "DifficultyProfile" ADD CONSTRAINT "DifficultyProfile_setBy_fkey"
    FOREIGN KEY ("setBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
