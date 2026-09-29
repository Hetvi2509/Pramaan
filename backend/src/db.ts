import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient(process.env.DATABASE_URL ? {
  datasources: { db: { url: process.env.DATABASE_URL } },
} : undefined);
