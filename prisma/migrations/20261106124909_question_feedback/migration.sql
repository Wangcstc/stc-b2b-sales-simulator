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
CREATE INDEX "QuestionFeedback_bankId_variantId_idx" ON "QuestionFeedback"("bankId", "variantId");

-- AddForeignKey
ALTER TABLE "QuestionFeedback" ADD CONSTRAINT "QuestionFeedback_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
