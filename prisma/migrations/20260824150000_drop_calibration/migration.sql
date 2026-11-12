-- 删掉「正式业务员校准任务」整套（2026-08-24 王老师：「没有需要校准的任务，请直接删」）
--
-- ★ 删之前先查底 ★ 这套东西从来没有被真正用过：
--   · CalibrationTask 8 行，**全是 PENDING**（自动生成的计划），sessionId 全为 null；
--   · Session.mode = 'CALIBRATION' **零行**——校准局一局都没有人打过；
--   · poolType = 'CALIBRATION' 的 21 份变体**零引用**（没有任何 Session 指向它们）。
-- 所以下面的 DELETE / DROP 不丢任何可回放的历史数据。
--
-- ★ 保留的是另一个「校准」★ 主管在报告页填自己的判分、与系统分逐力对照的
-- **标尺校准**（Calibration / ScoreCalibration 两张表）一个字都没动——
-- 那是教练工具，不是派给业务员的任务，两者只是同名。

-- ── ① 校准任务表与它的两个枚举 ──
DROP TABLE "CalibrationTask";
DROP TYPE "CalibrationTaskStatus";
DROP TYPE "CalibrationTaskType";

-- 校准周期号（C-简码-YYYYMMDD）跟着任务一起走
ALTER TABLE "User" DROP COLUMN "calibrationCycleId";

-- ── ② ParticipationMode：CALIBRATION → WEEKLY_EXAM ──
-- 正式业务员现在走的是「每周至少 2 场考试」，不是校准。
-- 名字留着 CALIBRATION，只会让人以为他还在做校准。
-- Postgres 不支持 ALTER TYPE ... DROP VALUE，只能重建类型。
ALTER TYPE "ParticipationMode" RENAME TO "ParticipationMode_old";
CREATE TYPE "ParticipationMode" AS ENUM ('ADMISSION', 'WEEKLY_EXAM', 'NONE');
ALTER TABLE "User" ALTER COLUMN "participationMode" DROP DEFAULT;
ALTER TABLE "User" ALTER COLUMN "participationMode" TYPE "ParticipationMode"
  USING (
    CASE "participationMode"::text
      WHEN 'CALIBRATION' THEN 'WEEKLY_EXAM'
      ELSE "participationMode"::text
    END
  )::"ParticipationMode";
ALTER TABLE "User" ALTER COLUMN "participationMode" SET DEFAULT 'NONE';
DROP TYPE "ParticipationMode_old";

-- ── ③ 校准题池的 21 份变体 ──
-- 没有任何 Session 指向它们，但**有两份背调资料包挂在上面**
-- （P3-CAL-001 / P12-CAL-001，给校准的两道困难题用的），
-- 外键 BgPackage_variantId_fkey 会拦住删除——先删包，再删变体。
-- 人设与背调包的 JSON 也一并从 p0/ 移除（git 里查得回来）。
DELETE FROM "BgPackage"
  WHERE "variantId" IN (SELECT id FROM "PersonaVariant" WHERE "poolType" = 'CALIBRATION');
DELETE FROM "PersonaVariant" WHERE "poolType" = 'CALIBRATION';

ALTER TYPE "PoolType" RENAME TO "PoolType_old";
CREATE TYPE "PoolType" AS ENUM ('DRILL', 'ADMISSION_EXAM');
ALTER TABLE "PersonaVariant" ALTER COLUMN "poolType" DROP DEFAULT;
ALTER TABLE "PersonaVariant" ALTER COLUMN "poolType" TYPE "PoolType"
  USING ("poolType"::text::"PoolType");
ALTER TABLE "PersonaVariant" ALTER COLUMN "poolType" SET DEFAULT 'DRILL';
DROP TYPE "PoolType_old";

-- ── ④ SessionMode 去掉 CALIBRATION ──
-- 零行，安全。正式业务员的周考局与实习业务员的准入考试局共用 ADMISSION_EXAM。
ALTER TYPE "SessionMode" RENAME TO "SessionMode_old";
CREATE TYPE "SessionMode" AS ENUM ('DRILL', 'EXAM', 'ADMISSION_EXAM');
ALTER TABLE "Session" ALTER COLUMN "mode" DROP DEFAULT;
ALTER TABLE "Session" ALTER COLUMN "mode" TYPE "SessionMode"
  USING ("mode"::text::"SessionMode");
ALTER TABLE "Session" ALTER COLUMN "mode" SET DEFAULT 'DRILL';
DROP TYPE "SessionMode_old";
