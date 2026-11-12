-- 折算前的原始局分。
--
-- 难度系数改成「只折算局分、不动门槛」之后（王老师 2026-08-23 裁定），
-- Score.rawScore 存的是折算【之后】的分。要答得出「他 70 分为什么显示 65」，
-- 折算之前那个数也得留着。系数本身已经记在 Session.difficultyFactor 上。
--
-- 历史行留 NULL：2026-08-23 之前没有难度系数，那时 rawScore 就是原始分本身。
ALTER TABLE "Score" ADD COLUMN "baselineScore" INTEGER;
