-- CreateTable
CREATE TABLE "CustodyEvent" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "caseId" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "ts" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "filename" TEXT,
    "sha256" TEXT,
    "detail" TEXT,
    "prev_hash" TEXT NOT NULL,
    "event_hash" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "CustodyEvent_caseId_seq_key" ON "CustodyEvent"("caseId", "seq");
