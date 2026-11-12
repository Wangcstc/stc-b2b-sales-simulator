-- 考纲版本化（D1-A，产品化）。
-- 默认空串：历史行不炸，重跑一次 seed 就会补上当前考纲版本。
ALTER TABLE "Persona" ADD COLUMN "syllabus" TEXT NOT NULL DEFAULT '';
