// ============================================================
// The assistant's read-only lookups over the case database, plus the
// glossary lookup.
//
// Same shape as the SIH_147 assistant's history_tools.py, and for the same
// reason: the model never writes a query. Unlike the qubits-dealflow
// assistant it is modelled on — which hands the LLM a SQL tool behind a
// SELECT-only Postgres role — there is no SQL surface here at all. Every
// lookup is a fixed Prisma call, and `userId` is supplied by the server from
// the verified JWT, never as an argument the model can pass or override. A
// fully jailbroken model can read one user's own cases and nothing else, and
// cannot write a row.
// ============================================================

import { prisma } from "../db";
import { lookupTerm, termIndex } from "./glossary";

const MAX_ROWS = 50;
/** Ceiling on the characters of one tool result. Parsed forensic structures
 *  run to thousands of log entries; the whole thing would blow the context
 *  window and the model only ever needs the shape plus a sample. */
const MAX_RESULT_CHARS = 3500;
/** Items kept from any array in a tool result; the rest become a count. */
const MAX_ARRAY_ITEMS = 6;
const MAX_STRING_CHARS = 240;

export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

type Args = Record<string, unknown>;

function clampLimit(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(Math.trunc(n), MAX_ROWS));
}

function asId(value: unknown): number | null {
  const n = Number(value);
  // A non-numeric id (the fixture case numbers look like "PRM-2026-0142") must
  // not reach Prisma: it throws rather than returning nothing.
  return Number.isInteger(n) ? n : null;
}

/** Shorten long arrays and strings, saying how much was dropped. Parsed disk
 *  structures hold hundreds of log entries; the model needs the shape, a few
 *  samples and the total, and every token of the rest is spent against a
 *  per-minute budget that the next question also needs. */
function compact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > MAX_STRING_CHARS ? `${value.slice(0, MAX_STRING_CHARS)}... (+${value.length - MAX_STRING_CHARS} chars)` : value;
  }
  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ARRAY_ITEMS).map((v) => compact(v, depth + 1));
    return value.length > MAX_ARRAY_ITEMS ? [...head, `... ${value.length - MAX_ARRAY_ITEMS} more of ${value.length} items not shown`] : head;
  }
  if (value && typeof value === "object" && depth < 8) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, compact(v, depth + 1)]));
  }
  return value;
}

/** Serialise a tool result, truncating rather than letting it run away. */
function render(value: unknown): string {
  const text = JSON.stringify(compact(JSON.parse(JSON.stringify(value ?? null))));
  if (text.length <= MAX_RESULT_CHARS) return text;
  return (
    text.slice(0, MAX_RESULT_CHARS) +
    `\n\n[truncated at ${MAX_RESULT_CHARS} characters — this structure is larger than the assistant can read in one go. Say so rather than summarising it as complete.]`
  );
}

async function ownsCase(userId: number, caseId: number): Promise<boolean> {
  const c = await prisma.case.findUnique({ where: { id: caseId }, select: { userId: true } });
  return c?.userId === userId;
}

// ---------- where a case stands ----------
// Pramaan stores no "status" on a case, so progress is derived from what the
// engine has actually written for its evidence images: the dataTypes in
// ForensicsData. Each stage is done when its record exists. This is the logic
// behind "what is the next step" and "how many cases are finished" - answered
// from the database, never from whichever screen the examiner has open.

interface Stage {
  label: string;
  done: (types: string[]) => boolean;
  /** What to do when this is the first stage not yet done. */
  next: { screen: string; action: string };
}

const STAGES: Stage[] = [
  {
    label: "Evidence uploaded and hashed (M0)",
    done: (t) => t.includes("intake_hashes"),
    next: { screen: "Evidence", action: "Upload the DVR disk image; it is hashed on intake." },
  },
  {
    label: "Hashes verified",
    done: (t) => t.includes("media_hashes"),
    next: { screen: "Evidence", action: 'Click "Calculate MD5 + SHA-256 / verify" to prove the image is unchanged.' },
  },
  {
    label: "Device identified (M1)",
    done: (t) => t.includes("identification"),
    next: { screen: "Device ID", action: 'Run "Identify format" to find the recorder family.' },
  },
  {
    label: "Image parsed (M2)",
    done: (t) => t.includes("parsed_bundle"),
    next: { screen: "Image Parsing", action: 'Run "Parse evidence" to read the file system, index and logs.' },
  },
  {
    label: "Footage recovered (M4)",
    done: (t) => t.some((x) => x.startsWith("extraction_")),
    next: { screen: "Video Explorer", action: "Extract a recording, then check it on the Recovery screen." },
  },
];

const AFTER_RECOVERY = {
  screen: "Recovery, Analytics, then Report",
  action:
    "Review which clips passed the decode gate, run motion/object/face analysis on those, then generate the report and Section 63 draft. Deletion and Timeline screens show illustrative data today, not computed results.",
};

function progressOf(types: string[]) {
  const done = STAGES.filter((s) => s.done(types)).map((s) => s.label);
  const firstOpen = STAGES.find((s) => !s.done(types));
  return {
    stage: done.length ? done[done.length - 1] : "No evidence yet",
    stagesDone: done.length,
    stagesTotal: STAGES.length,
    next: firstOpen ? firstOpen.next : AFTER_RECOVERY,
  };
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "explain_term",
      description:
        "Look up a DVR-forensics, Pramaan-pipeline or Indian evidence-law term and get its definition and how it is used in this tool. Use this for ANY question of the form 'what is X', 'what does X mean', 'explain X' before answering from general knowledge, so the explanation matches what Pramaan actually computes.",
      parameters: {
        type: "object",
        properties: {
          term: {
            type: "string",
            description: "The term as the user wrote it, e.g. 'HIKBTREE', 'decode gate', 'section 63', 'repaired'.",
          },
        },
        required: ["term"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_terms",
      description:
        "List every term the glossary covers, grouped by topic. Use when the user asks what you can explain, or when explain_term found nothing and you want to offer the nearest terms.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_cases",
      description:
        "List the signed-in examiner's own cases, newest first, each with its derived pipeline stage and next step. Use for 'how many cases', 'which cases are done', 'what is the status of my cases'. Pramaan has no 'completed' flag; report the stage instead.",
      parameters: {
        type: "object",
        properties: { limit: { type: "integer", description: "How many to return (1-50, default 10)." } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "case_progress",
      description:
        "Where one case stands in the Pramaan pipeline, per evidence file, and the concrete next step with the screen to do it on. Use for 'what is the next step', 'what should I do next', 'how far along is case N'. Always pass the case number the user named; if they named none, use the case in the screen snapshot.",
      parameters: {
        type: "object",
        properties: { caseId: { type: "integer", description: "The numeric case id." } },
        required: ["caseId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "case_detail",
      description:
        "Full stored record of one case: name, description, when it was opened, and every evidence file on it with its hash, size and which forensic structures have been parsed from it.",
      parameters: {
        type: "object",
        properties: { caseId: { type: "integer", description: "The numeric case id." } },
        required: ["caseId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_evidence",
      description: "The evidence files on one case, with SHA-256, size and upload time.",
      parameters: {
        type: "object",
        properties: {
          caseId: { type: "integer", description: "The numeric case id." },
          limit: { type: "integer", description: "How many to return (1-50, default 50)." },
        },
        required: ["caseId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "forensics_data",
      description:
        "Read what the Python engine parsed out of one evidence image — the master sector, HIKBTREE index, system logs, device identification or extraction results. Call without dataType first to see which types exist for that image.",
      parameters: {
        type: "object",
        properties: {
          imageId: { type: "integer", description: "The numeric evidence-file id (from case_detail or list_evidence)." },
          dataType: {
            type: "string",
            description:
              "Which stored structure to read, e.g. 'master_sector', 'hikbtree', 'system_logs'. Omit to list the available types with their sizes.",
          },
        },
        required: ["imageId"],
      },
    },
  },
];

/**
 * Bind the tools to one authenticated user. `userId` is closed over, so it is
 * not part of any tool's argument schema and the model cannot reach another
 * examiner's cases by asking.
 */
export function toolRunner(userId: number) {
  return async function run(name: string, args: Args): Promise<string> {
    switch (name) {
      case "explain_term": {
        const hits = lookupTerm(String(args.term ?? ""));
        if (!hits.length) {
          return render({
            found: false,
            note: "No glossary entry matches. If it is a standard DVR, forensic or legal term you are certain about, give a short general definition and begin with: Pramaan has no entry for this, but in general. Otherwise say you do not know it and offer list_terms. Never present a general definition as how Pramaan behaves.",
          });
        }
        return render({ found: true, terms: hits });
      }

      case "list_terms":
        return render(termIndex());

      case "list_cases": {
        const cases = await prisma.case.findMany({
          where: { userId },
          orderBy: { created_at: "desc" },
          take: clampLimit(args.limit, 10),
          include: { images: { select: { forensics: { select: { dataType: true } } } } },
        });
        return render(
          cases.map((c) => {
            // A case is as far along as its furthest image.
            const best = c.images
              .map((i) => progressOf(i.forensics.map((f) => f.dataType)))
              .sort((a, b) => b.stagesDone - a.stagesDone)[0];
            const p = best ?? progressOf([]);
            return {
              id: c.id,
              name: c.name,
              description: c.description,
              opened: c.created_at,
              evidenceFiles: c.images.length,
              stage: p.stage,
              next: p.next.action,
            };
          }),
        );
      }

      case "case_progress": {
        const caseId = asId(args.caseId);
        if (caseId === null) return render({ error: "caseId must be a number." });
        if (!(await ownsCase(userId, caseId))) return render({ error: "No such case for this examiner." });
        const images = await prisma.imageFile.findMany({
          where: { caseId },
          orderBy: { created_at: "desc" },
          include: { forensics: { select: { dataType: true } } },
        });
        if (!images.length) {
          return render({
            caseId,
            stage: "No evidence yet",
            next: STAGES[0].next,
            note: "Nothing has been uploaded to this case.",
          });
        }
        const perImage = images.map((i) => ({
          imageId: i.id,
          filename: i.filename,
          ...progressOf(i.forensics.map((f) => f.dataType)),
        }));
        const furthest = [...perImage].sort((a, b) => b.stagesDone - a.stagesDone)[0];
        return render({ caseId, stage: furthest.stage, next: furthest.next, evidence: perImage });
      }

      case "case_detail": {
        const caseId = asId(args.caseId);
        if (caseId === null) return render({ error: "caseId must be a number." });
        if (!(await ownsCase(userId, caseId))) return render({ error: "No such case for this examiner." });
        const c = await prisma.case.findUnique({
          where: { id: caseId },
          include: {
            images: {
              orderBy: { created_at: "desc" },
              include: { forensics: { select: { dataType: true, created_at: true } } },
            },
          },
        });
        if (!c) return render({ error: "No such case for this examiner." });
        return render({
          id: c.id,
          name: c.name,
          description: c.description,
          opened: c.created_at,
          evidence: c.images.map((i) => ({
            id: i.id,
            filename: i.filename,
            sha256: i.hash_sha256,
            sizeBytes: i.size_bytes,
            uploaded: i.created_at,
            parsedStructures: i.forensics.map((f) => f.dataType),
          })),
        });
      }

      case "list_evidence": {
        const caseId = asId(args.caseId);
        if (caseId === null) return render({ error: "caseId must be a number." });
        if (!(await ownsCase(userId, caseId))) return render({ error: "No such case for this examiner." });
        const images = await prisma.imageFile.findMany({
          where: { caseId },
          orderBy: { created_at: "desc" },
          take: clampLimit(args.limit, MAX_ROWS),
        });
        return render(
          images.map((i) => ({
            id: i.id,
            filename: i.filename,
            sha256: i.hash_sha256,
            sizeBytes: i.size_bytes,
            uploaded: i.created_at,
          })),
        );
      }

      case "forensics_data": {
        const imageId = asId(args.imageId);
        if (imageId === null) return render({ error: "imageId must be a number." });
        const image = await prisma.imageFile.findUnique({
          where: { id: imageId },
          include: { case: { select: { userId: true, id: true, name: true } } },
        });
        if (!image || image.case.userId !== userId) {
          return render({ error: "No such evidence file for this examiner." });
        }

        const dataType = typeof args.dataType === "string" ? args.dataType.trim() : "";
        if (!dataType) {
          const rows = await prisma.forensicsData.findMany({
            where: { imageFileId: imageId },
            select: { dataType: true, created_at: true, data: true },
          });
          return render({
            imageId,
            filename: image.filename,
            available: rows.map((r) => ({ dataType: r.dataType, parsedAt: r.created_at, sizeChars: r.data.length })),
            note: rows.length ? "Call again with one of these dataType values." : "Nothing has been parsed from this image yet.",
          });
        }

        const row = await prisma.forensicsData.findUnique({
          where: { imageFileId_dataType: { imageFileId: imageId, dataType } },
        });
        if (!row) {
          const types = await prisma.forensicsData.findMany({
            where: { imageFileId: imageId },
            select: { dataType: true },
          });
          return render({
            error: `No '${dataType}' data for this image.`,
            available: types.map((t) => t.dataType),
          });
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.data);
        } catch {
          parsed = row.data;
        }
        return render({ imageId, filename: image.filename, dataType, parsedAt: row.created_at, data: parsed });
      }

      default:
        return render({ error: `Unknown tool '${name}'.` });
    }
  };
}
