import crypto from "crypto";
import { prisma } from "./db";

// Per-case hash chain: each event's hash covers its fields and the previous event's hash,
// so changing or removing any stored event breaks every link after it.
// Not signed: someone who can write the database can recompute the whole chain.
export const GENESIS = "0".repeat(64);

type Fields = { caseId: number; seq: number; ts: string; actor: string; action: string; filename: string | null; sha256: string | null; detail: string | null };

export const eventHash = (f: Fields, prev: string) =>
  crypto.createHash("sha256").update(JSON.stringify([f.caseId, f.seq, f.ts, f.actor, f.action, f.filename, f.sha256, f.detail, prev])).digest("hex");

export async function logEvent(caseId: number, actor: string, action: string, extra: { filename?: string; sha256?: string | null; detail?: string } = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const last = await prisma.custodyEvent.findFirst({ where: { caseId }, orderBy: { seq: "desc" } });
    const f: Fields = { caseId, seq: last ? last.seq + 1 : 0, ts: new Date().toISOString(), actor, action,
      filename: extra.filename ?? null, sha256: extra.sha256 ?? null, detail: extra.detail ?? null };
    const prev = last ? last.event_hash : GENESIS;
    try { return await prisma.custodyEvent.create({ data: { ...f, prev_hash: prev, event_hash: eventHash(f, prev) } }); }
    catch (e: any) { if (e?.code !== "P2002") throw e; } // another event took this seq: re-read and retry
  }
  throw new Error("Could not append custody event");
}

export async function verifyChain(caseId: number) {
  const events = await prisma.custodyEvent.findMany({ where: { caseId }, orderBy: { seq: "asc" } });
  let prev = GENESIS;
  for (const [i, e] of events.entries()) {
    if (e.seq !== i) return { events, valid: false, brokenAt: i, message: `Event ${i} is missing (found #${e.seq})` };
    if (e.prev_hash !== prev) return { events, valid: false, brokenAt: e.seq, message: `Event #${e.seq} does not link to the one before it` };
    if (eventHash(e, prev) !== e.event_hash) return { events, valid: false, brokenAt: e.seq, message: `Event #${e.seq} was changed after it was recorded` };
    prev = e.event_hash;
  }
  return { events, valid: true, brokenAt: null, message: events.length ? `${events.length} events re-hashed, every link matches` : "No events recorded yet" };
}
