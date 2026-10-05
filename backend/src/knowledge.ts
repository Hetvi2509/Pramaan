import { prisma } from "./db";
import { logEvent } from "./custody";

// Forensic knowledge base. Stores traits observed on past evidence so a later image can be matched
// against them. Nothing here identifies a vendor on its own: a match is a lead that an analyst confirms.

export const KNOWLEDGE_DB_VERSION = "2026.10";

// Two images are treated as the same recorder layout only when they agree almost completely.
// Below that they stay separate records and the older one is offered as a candidate to check by hand.
const SAME = 0.9;
const WORTH_REPORTING = 0.5;

export type Fingerprint = { tokens: string[]; features: Record<string, unknown>; kind: string };

/** Jaccard overlap, with the agreeing and differing tokens so a match can be explained. */
export function similarity(a: string[], b: string[]) {
  const left = new Set(a), right = new Set(b);
  const shared = [...left].filter((t) => right.has(t));
  const union = new Set([...a, ...b]);
  return { score: union.size ? shared.length / union.size : 0, shared, onlyNew: [...left].filter((t) => !right.has(t)), onlyStored: [...right].filter((t) => !left.has(t)) };
}

// Confidence is a stated policy, not a measurement: it reflects how much corroboration a record has,
// and only an analyst's confirmation reaches the top band.
export const confidenceFor = (status: string, observations: number) =>
  status === "REJECTED" ? 0
    : status === "VALIDATED" ? 0.95
      : status === "CANDIDATE" ? Math.min(0.8, 0.5 + 0.05 * observations)
        : Math.min(0.45, 0.2 + 0.05 * observations);

const labelFor = (fp: Fingerprint, vendor: string | null) => {
  const f = fp.features as { adapter?: string; family?: string; container?: string };
  if (vendor) return `${vendor} (${f.adapter ?? "unknown"} layout)`;
  if (f.family && f.family !== "Unknown") return `${f.family} layout`;
  if (f.adapter && f.adapter !== "none") return `${f.adapter} layout, brand not determined`;
  return "Unknown recorder layout";
};

type Source = { caseId: number; imageFileId: number; filename: string; sha256: string | null; at: string };

/**
 * Compare a new fingerprint against what this user's knowledge base already holds, then record it.
 * Returns the stored row plus every candidate worth a human look. Never assigns a vendor by itself.
 */
export async function observe(userId: number, fp: Fingerprint, source: Source, parserVersion: string, actor: string) {
  const vendor = (fp.features as { vendor_observed?: string | null }).vendor_observed ?? null;
  const stored = await prisma.fingerprint.findMany({ where: { userId, kind: fp.kind } });

  const scored = stored
    .map((row) => ({ row, ...similarity(fp.tokens, JSON.parse(row.tokens) as string[]) }))
    .filter((m) => m.score >= WORTH_REPORTING)
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  // A rejected record is never revived by a new sighting; it stays rejected and is reported as a match only.
  if (best && best.score >= SAME && best.row.status !== "REJECTED") {
    const sources: Source[] = JSON.parse(best.row.sources);
    const fresh = !sources.some((s) => s.sha256 && s.sha256 === source.sha256);
    const observations = best.row.observations + (fresh ? 1 : 0);
    // Independent corroboration moves a record forward one step only. VALIDATED stays an analyst's decision.
    const status = best.row.status === "OBSERVED" && observations >= 2 ? "CANDIDATE" : best.row.status;
    const row = await prisma.fingerprint.update({
      where: { id: best.row.id },
      data: {
        observations, status, confidence: confidenceFor(status, observations), last_seen: new Date(),
        sources: JSON.stringify(fresh ? [...sources, source] : sources),
        vendor_guess: best.row.vendor_guess ?? vendor,
      },
    });
    await logEvent(source.caseId, actor, "Fingerprint matched known layout", { filename: source.filename,
      detail: `#${row.id} ${row.label} · ${(best.score * 100).toFixed(0)}% of traits agree · now ${row.status} on ${observations} observation(s)` });
    return { matched: true, row, candidates: scored.slice(1, 4).map(brief), best: brief(best) };
  }

  const row = await prisma.fingerprint.create({
    data: {
      userId, kind: fp.kind, label: labelFor(fp, vendor), tokens: JSON.stringify(fp.tokens),
      features: JSON.stringify(fp.features), vendor_guess: vendor, status: "OBSERVED",
      confidence: confidenceFor("OBSERVED", 1), observations: 1, sources: JSON.stringify([source]),
      parser_version: parserVersion,
    },
  });
  await logEvent(source.caseId, actor, "New fingerprint recorded", { filename: source.filename,
    detail: `#${row.id} ${row.label} · ${fp.tokens.length} traits · OBSERVED${scored.length ? `, ${scored.length} similar record(s) need checking` : ""}` });
  return { matched: false, row, candidates: scored.slice(0, 4).map(brief), best: null };
}

const brief = (m: { row: { id: number; label: string; status: string; vendor_guess: string | null; observations: number }; score: number; shared: string[]; onlyNew: string[]; onlyStored: string[] }) => ({
  id: m.row.id, label: m.row.label, status: m.row.status, vendor_guess: m.row.vendor_guess,
  observations: m.row.observations, similarity: Number(m.score.toFixed(3)),
  requires_validation: m.row.status !== "VALIDATED",
  shared: m.shared, only_in_this_evidence: m.onlyNew, only_in_stored_record: m.onlyStored,
});

/** Records similar to one already stored, for the "have we seen this recorder before?" question. */
export async function similarTo(userId: number, id: number) {
  const target = await prisma.fingerprint.findFirst({ where: { id, userId } });
  if (!target) return null;
  const others = await prisma.fingerprint.findMany({ where: { userId, kind: target.kind, id: { not: id } } });
  const tokens = JSON.parse(target.tokens) as string[];
  return {
    target,
    matches: others
      .map((row) => ({ row, ...similarity(tokens, JSON.parse(row.tokens) as string[]) }))
      .filter((m) => m.score >= WORTH_REPORTING)
      .sort((a, b) => b.score - a.score)
      .map(brief),
  };
}

const ALLOWED: Record<string, string[]> = {
  VALIDATED: ["OBSERVED", "CANDIDATE"],
  REJECTED: ["OBSERVED", "CANDIDATE", "VALIDATED"],
  CANDIDATE: ["OBSERVED"],
  DEPRECATED: ["VALIDATED"],
};

/** An analyst's decision. This is the only route into VALIDATED; no automatic path reaches it. */
export async function setStatus(userId: number, id: number, status: string, note: string | undefined, actor: string) {
  const row = await prisma.fingerprint.findFirst({ where: { id, userId } });
  if (!row) return { error: "Fingerprint not found" };
  if (!ALLOWED[status]) return { error: `Unknown status ${status}` };
  if (!ALLOWED[status].includes(row.status)) return { error: `A ${row.status} record cannot be set to ${status}` };

  const updated = await prisma.fingerprint.update({
    where: { id },
    data: { status, confidence: confidenceFor(status, row.observations), note: note ?? row.note },
  });
  const sources: Source[] = JSON.parse(row.sources);
  for (const caseId of new Set(sources.map((s) => s.caseId)))
    await logEvent(caseId, actor, `Fingerprint ${status.toLowerCase()} by analyst`, { detail: `#${id} ${row.label}: ${row.status} → ${status}${note ? ` · ${note}` : ""}` });
  return { row: updated };
}
