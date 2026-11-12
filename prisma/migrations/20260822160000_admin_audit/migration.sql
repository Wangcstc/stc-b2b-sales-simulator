-- 管理动作流水。只增一张表，不动任何既有数据、不改任何既有列。
--
-- ★ 为什么要有它 ★ 在这之前全系统只有「改期别」留了痕（AccessDecision）。
-- 另外十一个动作——加人、改角色、改身份、重置口令、停用、恢复、删除、
-- 标假期、标调休、标请假、点重算——一条记录都没有。一个人的口令被谁重置过、
-- 某天为什么标成假期、上个月那次重算是谁点的，事后一律查不到。
--
-- ★ subjectId 可空 ★ 标假期、点重算这类动作没有「被操作的人」，
-- 那不是缺数据，是这个动作本来就针对全员。

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

CREATE INDEX "AdminAudit_at_idx" ON "AdminAudit"("at");
CREATE INDEX "AdminAudit_subjectId_at_idx" ON "AdminAudit"("subjectId", "at");

-- 外键都用 RESTRICT：流水里指着的人不许被硬删。
-- 账号管理页本来就只让「一局都没开过」的账号真删，其余一律走停用——口径一致。
ALTER TABLE "AdminAudit" ADD CONSTRAINT "AdminAudit_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AdminAudit" ADD CONSTRAINT "AdminAudit_subjectId_fkey"
    FOREIGN KEY ("subjectId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
