-- CreateTable
CREATE TABLE "AnalysisResult" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "caseId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "imageFileId" INTEGER,
    "recordingId" TEXT,
    "channel" INTEGER,
    "clip_start" TEXT,
    "clip_end" TEXT,
    "data" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "AnalysisResult_caseId_idx" ON "AnalysisResult"("caseId");
