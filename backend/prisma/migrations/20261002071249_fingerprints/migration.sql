-- CreateTable
CREATE TABLE "Fingerprint" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "tokens" TEXT NOT NULL,
    "features" TEXT NOT NULL,
    "vendor_guess" TEXT,
    "confidence" REAL NOT NULL,
    "status" TEXT NOT NULL,
    "observations" INTEGER NOT NULL DEFAULT 1,
    "sources" TEXT NOT NULL,
    "parser_version" TEXT NOT NULL,
    "note" TEXT,
    "first_seen" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" INTEGER NOT NULL
);

-- CreateIndex
CREATE INDEX "Fingerprint_userId_kind_idx" ON "Fingerprint"("userId", "kind");
