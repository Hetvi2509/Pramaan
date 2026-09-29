-- CreateTable
CREATE TABLE "User" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "username" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "last_login" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Case" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" INTEGER NOT NULL,
    CONSTRAINT "Case_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ImageFile" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "filename" TEXT NOT NULL,
    "path_on_disk" TEXT NOT NULL,
    "hash_sha256" TEXT,
    "size_bytes" INTEGER,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "caseId" INTEGER NOT NULL,
    CONSTRAINT "ImageFile_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ForensicsData" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "dataType" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "imageFileId" INTEGER NOT NULL,
    CONSTRAINT "ForensicsData_imageFileId_fkey" FOREIGN KEY ("imageFileId") REFERENCES "ImageFile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Case_userId_idx" ON "Case"("userId");

-- CreateIndex
CREATE INDEX "ImageFile_caseId_idx" ON "ImageFile"("caseId");

-- CreateIndex
CREATE UNIQUE INDEX "ImageFile_path_on_disk_caseId_key" ON "ImageFile"("path_on_disk", "caseId");

-- CreateIndex
CREATE INDEX "ForensicsData_imageFileId_idx" ON "ForensicsData"("imageFileId");

-- CreateIndex
CREATE UNIQUE INDEX "ForensicsData_imageFileId_dataType_key" ON "ForensicsData"("imageFileId", "dataType");
