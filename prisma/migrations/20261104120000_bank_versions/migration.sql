-- v8.2 柜子去耦合：题库包版本化。
--
-- · 新表 BankVersion：每装入一个题库包版本记一行，同一时刻只有一个「当前版本」。
-- · PersonaVariant 加 bankVersionId / enabledInBank；题目编号的唯一性改为「题库版本 + 编号」，
--   因为同一题库的不同版本里，同一道题的编号相同。
-- · 已有的题（v8.2 之前灌进来的）bankVersionId 为 null，行和历史局都保留。

-- DropIndex
DROP INDEX "PersonaVariant_variantId_key";

-- AlterTable
ALTER TABLE "PersonaVariant" ADD COLUMN     "bankVersionId" TEXT,
ADD COLUMN     "enabledInBank" BOOLEAN NOT NULL DEFAULT true;

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

-- CreateIndex
CREATE UNIQUE INDEX "BankVersion_bankId_bankVersion_key" ON "BankVersion"("bankId", "bankVersion");

-- CreateIndex
CREATE INDEX "PersonaVariant_variantId_idx" ON "PersonaVariant"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "PersonaVariant_bankVersionId_variantId_key" ON "PersonaVariant"("bankVersionId", "variantId");

-- AddForeignKey
ALTER TABLE "PersonaVariant" ADD CONSTRAINT "PersonaVariant_bankVersionId_fkey" FOREIGN KEY ("bankVersionId") REFERENCES "BankVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

