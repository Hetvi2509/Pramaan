import express from "express";
import cors from "cors";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as os from "os";
import bcrypt from "bcryptjs";
import multer from "multer";
import { prisma } from "./db";
import { signToken, requireAuth, AuthedRequest } from "./auth";
import { execFile } from "child_process";
import { logEvent, verifyChain } from "./custody";
import { observe, similarTo, setStatus, KNOWLEDGE_DB_VERSION } from "./knowledge";
import { startTask, getTask, ENGINE_DIR } from "./engine";
import { runOcrVideo, runOcrImage, warmOcrWorker } from "./ocrWorker";
import { answer, AllModelsBusy, ChatNotConfigured, type InboundMessage } from "./chat/agent";

// backend/.env holds GROQ_API_KEY for the assistant. Node's own loader, so no
// dotenv dependency; absent on Node < 20.12 and absent when there is no .env,
// and in both cases the assistant route reports itself unconfigured.
try {
  process.loadEnvFile?.(path.join(__dirname, "..", ".env"));
} catch {
  /* no .env on disk — fine, every other route works without one */
}

const FFMPEG_PATH = path.join(ENGINE_DIR, "ffmpeg.exe");

const SALT_ROUNDS = 10;
const STORAGE_DIR = process.env.STORAGE_DIR ? path.resolve(process.env.STORAGE_DIR) : path.join(__dirname, "..");
const UPLOAD_DIR = path.join(STORAGE_DIR, "uploads");
const OUTPUT_DIR = path.join(STORAGE_DIR, "outputs");

// ---------- tool output folder ----------
// Each case has one folder where the analysis tools write their results. The examiner can choose it; until then it
// is a folder inside the data folder, so the tools work on a fresh install with nothing to set up. The choice lives
// here in the data folder (not in the browser), so it survives a reinstall and is the same on every screen.
const SETTINGS_FILE = path.join(STORAGE_DIR, "settings.json");
const readSettings = (): { outputDirs?: Record<string, string> } => { try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")); } catch { return {}; } };
const defaultOutputDir = (caseId: number | null) => path.join(OUTPUT_DIR, caseId === null ? "tools" : `${caseId}`, ...(caseId === null ? [] : ["tools"]));

/** Creates the folder if needed and proves a file can be written there. Returns the reason it cannot be used, or null. */
function folderProblem(dir: string): string | null {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.pramaan-write-test-${process.pid}`);
    fs.writeFileSync(probe, "");
    fs.rmSync(probe);
    return null;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "That drive or path does not exist on this computer." : "This computer will not let Pramaan write to that folder.";
  }
}

/** The folder to use for a case: the saved one if it still works on this computer, else the default. */
function resolveOutputDir(caseId: number | null) {
  const saved = caseId === null ? undefined : readSettings().outputDirs?.[String(caseId)];
  if (saved) {
    const problem = folderProblem(saved);
    if (!problem) return { dir: saved, isDefault: false, problem: null as string | null };
    const dir = defaultOutputDir(caseId);
    fs.mkdirSync(dir, { recursive: true });
    return { dir, isDefault: true, problem: `The saved folder "${saved}" cannot be used on this computer (${problem}) so the default folder is being used.` };
  }
  const dir = defaultOutputDir(caseId);
  fs.mkdirSync(dir, { recursive: true });
  return { dir, isDefault: true, problem: null as string | null };
}

/** A tool run that arrives without an output folder still gets one, so it never fails for want of a setting. */
function withOutputDefaults(kind: string, body: any, dir: string) {
  if (kind === "motion" && typeof body.outputDir !== "string") body.outputDir = dir;
  if (kind === "faces" && typeof body.output_dir !== "string") body.output_dir = dir;
  if (kind === "objects" && typeof body.output !== "string") body.output = path.join(dir, `objects-${Date.now()}.mp4`);
}
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json());
app.get("/api/health", (_req, res) => res.json({ success: true }));

const upload = multer({ dest: UPLOAD_DIR });

function hashFile(filePath: string): Promise<{ sha256: string; md5: string }> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const md5 = crypto.createHash("md5");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (c) => { hash.update(c); md5.update(c); });
    stream.on("end", () => resolve({ sha256: hash.digest("hex"), md5: md5.digest("hex") }));
    stream.on("error", reject);
  });
}

const who = async (req: AuthedRequest) => (await prisma.user.findUnique({ where: { id: req.userId! } }))?.username ?? `user ${req.userId}`;

async function verifyCaseOwnership(userId: number, caseId: number): Promise<boolean> {
  if (!Number.isInteger(caseId)) return false; // non-numeric id (e.g. "PRM-2026-0142") must not reach Prisma: it throws and kills the process
  const c =await prisma.case.findUnique({ where: { id: caseId }, select: { userId: true } });
  return c?.userId === userId;
}

// ---------- auth ----------
app.post("/api/auth/signup", async (req, res) => {
  try {
    const { username, email, password } = req.body || {};
    if (!username || !email || !password) {
      return res.status(400).json({ success: false, error: "username, email and password are required" });
    }
    const existing = await prisma.user.findFirst({ where: { OR: [{ username }, { email }] } });
    if (existing) return res.status(409).json({ success: false, error: "A user with that username or email already exists." });
    const hashed = await bcrypt.hash(password, SALT_ROUNDS);
    const user = await prisma.user.create({ data: { username, email, password: hashed } });
    const token = signToken(user.id);
    res.json({ success: true, user: { id: user.id, username: user.username, email: user.email }, token });
  } catch (error) {
    res.status(500).json({ success: false, error: `Signup failed: ${(error as Error).message}` });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) return res.status(401).json({ success: false, error: "Invalid username or password." });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ success: false, error: "Invalid username or password." });
    await prisma.user.update({ where: { id: user.id }, data: { last_login: new Date() } });
    const token = signToken(user.id);
    res.json({ success: true, user: { id: user.id, username: user.username, email: user.email }, token });
  } catch (error) {
    res.status(500).json({ success: false, error: `Login failed: ${(error as Error).message}` });
  }
});

// ---------- cases ----------
app.get("/api/cases", requireAuth, async (req: AuthedRequest, res) => {
  const cases = await prisma.case.findMany({ where: { userId: req.userId! }, orderBy: { created_at: "desc" } });
  res.json({ success: true, data: cases });
});

app.post("/api/cases", requireAuth, async (req: AuthedRequest, res) => {
  const { name, description } = req.body || {};
  if (!name) return res.status(400).json({ success: false, error: "name is required" });
  const c = await prisma.case.create({ data: { name, description, userId: req.userId! } });
  await logEvent(c.id, await who(req), "Case opened", { detail: name });
  res.json({ success: true, data: c });
});

app.get("/api/cases/:id", requireAuth, async (req: AuthedRequest, res) => {
  const caseId = Number(req.params.id);
  if (!(await verifyCaseOwnership(req.userId!, caseId)))
    return res.status(403).json({ success: false, error: "Access denied: You do not own this case" });
  const c = await prisma.case.findUnique({ where: { id: caseId } });
  if (!c) return res.status(404).json({ success: false, error: "Case not found" });
  res.json({ success: true, data: c });
});

app.delete("/api/cases/:id", requireAuth, async (req: AuthedRequest, res) => {
  const caseId = Number(req.params.id);
  if (!(await verifyCaseOwnership(req.userId!, caseId)))
    return res.status(403).json({ success: false, error: "Access denied: You do not own this case" });
  await logEvent(caseId, await who(req), "Case deleted");
  await prisma.forensicsData.deleteMany({ where: { image_file: { caseId } } });
  await prisma.imageFile.deleteMany({ where: { caseId } });
  await prisma.case.delete({ where: { id: caseId } });
  res.json({ success: true });
});

// ---------- evidence / image files ----------
app.get("/api/cases/:id/images", requireAuth, async (req: AuthedRequest, res) => {
  const caseId = Number(req.params.id);
  if (!(await verifyCaseOwnership(req.userId!, caseId)))
    return res.status(403).json({ success: false, error: "Access denied: You do not own this case" });
  const images = await prisma.imageFile.findMany({ where: { caseId }, orderBy: { created_at: "desc" } });
  res.json({ success: true, data: images });
});

app.post("/api/cases/:id/images", requireAuth, upload.single("file"), async (req: AuthedRequest, res) => {
  try {
    const caseId = Number(req.params.id);
    if (!(await verifyCaseOwnership(req.userId!, caseId)))
      return res.status(403).json({ success: false, error: "Access denied: You do not own this case" });
    const c = await prisma.case.findUnique({ where: { id: caseId } });
    if (!c) return res.status(404).json({ success: false, error: "Case not found" });
    if (!req.file) return res.status(400).json({ success: false, error: "file is required" });

    const filePath = `${req.file.path}${path.extname(req.file.originalname)}`;
    fs.renameSync(req.file.path, filePath);
    const filename = req.file.originalname;
    const hash = await hashFile(filePath);

    const existing = await prisma.imageFile.findFirst({ where: { path_on_disk: filePath, caseId } });
    if (existing) return res.status(409).json({ success: false, error: "This file has already been added to this case" });

    // What the examiner stated when adding it. Only known values are kept; free text is trimmed and capped.
    let meta: any = {};
    try { meta = JSON.parse(String(req.body?.meta ?? "{}")); } catch { /* no details sent */ }
    const SOURCES: Record<string, string> = { e01: "Expert Witness image (.E01)", dd: "raw image", file: "video file or other export" };
    const ZONES: Record<string, string> = { ist: "India (UTC+05:30)", utc: "UTC", unknown: "not known" };
    const intake = {
      source: typeof meta.source === "string" && SOURCES[meta.source] ? meta.source : null,
      acquiredOn: typeof meta.acquiredOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(meta.acquiredOn) ? meta.acquiredOn : null,
      timeZone: typeof meta.timeZone === "string" && ZONES[meta.timeZone] ? meta.timeZone : null,
      writeBlocker: meta.writeBlocker === true,
      notes: typeof meta.notes === "string" ? meta.notes.trim().slice(0, 1000) : "",
    };
    const records = [
      { dataType: "intake_hashes", data: JSON.stringify({ ...hash, scope: "uploaded file bytes", size_bytes: req.file.size }) },
      { dataType: "intake_notes", data: JSON.stringify(intake) },
      // The default is India time; only a different statement needs saving.
      ...(intake.timeZone === "utc" ? [{ dataType: "time_settings", data: JSON.stringify({ tzMinutes: 0, driftSeconds: 0 }) }] : []),
    ];
    const image = await prisma.imageFile.create({
      data: { path_on_disk: filePath, filename, caseId, hash_sha256: hash.sha256, size_bytes: req.file.size, forensics: { create: records } },
    });
    const stated = [
      intake.source && `source: ${SOURCES[intake.source]}`,
      intake.acquiredOn && `acquired ${intake.acquiredOn}`,
      intake.timeZone && `recorder time zone: ${ZONES[intake.timeZone]}`,
      `hardware write-blocker: ${intake.writeBlocker ? "stated as used" : "not stated"}`,
      intake.notes && `notes: ${intake.notes}`,
    ].filter(Boolean).join("; ");
    await logEvent(caseId, await who(req), "Evidence added", { filename, sha256: hash.sha256, detail: `${req.file.size} bytes, SHA-256 taken on upload; ${stated}` });
    res.json({ success: true, data: image });
  } catch (error) {
    res.status(500).json({ success: false, error: `Failed to process image file: ${(error as Error).message}` });
  }
});

// Byte-serving route (replaces images:load-base64).
app.get("/api/images/:id/file", requireAuth, async (req: AuthedRequest, res) => {
  const imageId = Number(req.params.id);
  const image = await prisma.imageFile.findUnique({ where: { id: imageId } });
  if (!image) return res.status(404).end();
  if (!(await verifyCaseOwnership(req.userId!, image.caseId))) return res.status(403).end();
  if (!fs.existsSync(image.path_on_disk)) return res.status(404).end();
  res.sendFile(image.path_on_disk);
});

// ---------- tool output folder ----------
app.get("/api/cases/:id/output-dir", requireAuth, async (req: AuthedRequest, res) => {
  const caseId = Number(req.params.id);
  if (!(await verifyCaseOwnership(req.userId!, caseId)))
    return res.status(403).json({ success: false, error: "Access denied: You do not own this case" });
  res.json({ success: true, ...resolveOutputDir(caseId), defaultDir: defaultOutputDir(caseId) });
});

// Body { dir } sets the folder; { dir: null } goes back to the default. The folder is created and test-written first.
app.put("/api/cases/:id/output-dir", requireAuth, async (req: AuthedRequest, res) => {
  const caseId = Number(req.params.id);
  if (!(await verifyCaseOwnership(req.userId!, caseId)))
    return res.status(403).json({ success: false, error: "Access denied: You do not own this case" });
  const raw = req.body?.dir;
  const settings = readSettings();
  const dirs = { ...(settings.outputDirs ?? {}) };
  if (raw === null || raw === "") {
    delete dirs[String(caseId)];
  } else {
    const dir = typeof raw === "string" ? raw.trim() : "";
    if (!dir || !path.isAbsolute(dir))
      return res.status(400).json({ success: false, error: "Enter the full path of a folder, for example C:\\Pramaan\\Output." });
    const problem = folderProblem(dir);
    if (problem) return res.status(400).json({ success: false, error: `Cannot use "${dir}". ${problem}` });
    dirs[String(caseId)] = path.resolve(dir);
  }
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ ...settings, outputDirs: dirs }, null, 2));
  const now = resolveOutputDir(caseId);
  await logEvent(caseId, await who(req), "Output folder set", { detail: now.dir });
  res.json({ success: true, ...now, defaultDir: defaultOutputDir(caseId) });
});

// ---------- analysis results (Analytics, Correlation) ----------
app.get("/api/cases/:id/analysis", requireAuth, async (req: AuthedRequest, res) => {
  const caseId = Number(req.params.id);
  if (!(await verifyCaseOwnership(req.userId!, caseId)))
    return res.status(403).json({ success: false, error: "Access denied: You do not own this case" });
  const rows = await prisma.analysisResult.findMany({ where: { caseId }, orderBy: { created_at: "desc" } });
  res.json({ success: true, data: rows.map((r) => ({ ...r, data: JSON.parse(r.data) })) });
});

// ---------- chain of custody ----------
app.get("/api/cases/:id/custody", requireAuth, async (req: AuthedRequest, res) => {
  const caseId = Number(req.params.id);
  if (!(await verifyCaseOwnership(req.userId!, caseId)))
    return res.status(403).json({ success: false, error: "Access denied: You do not own this case" });
  res.json({ success: true, data: await verifyChain(caseId) });
});

// Recorded when a report is produced. Only a hash and the file types are accepted, so the chain never holds
// free text from the client.
app.post("/api/cases/:id/report-generated", requireAuth, async (req: AuthedRequest, res) => {
  const caseId = Number(req.params.id);
  if (!(await verifyCaseOwnership(req.userId!, caseId)))
    return res.status(403).json({ success: false, error: "Access denied: You do not own this case" });
  const { sha256, formats } = req.body || {};
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return res.status(400).json({ success: false, error: "sha256 must be a 64-character hex hash" });
  const kinds = (Array.isArray(formats) ? formats : []).filter((f: unknown) => ["pdf", "json", "s63"].includes(String(f)));
  await logEvent(caseId, await who(req), "Report generated", { sha256, detail: kinds.length ? `files: ${kinds.join(", ")}` : undefined });
  res.json({ success: true });
});

app.get("/api/custody", requireAuth, async (req: AuthedRequest, res) => {
  const cases = await prisma.case.findMany({ where: { userId: req.userId! }, orderBy: { id: "asc" } });
  const chains = await Promise.all(cases.map(async (c) => ({ caseId: c.id, caseName: c.name, ...(await verifyChain(c.id)) })));
  res.json({ success: true, data: chains });
});

// ---------- forensic knowledge base ----------
const publicFingerprint = (f: any) => ({ ...f, tokens: JSON.parse(f.tokens), features: JSON.parse(f.features), sources: JSON.parse(f.sources) });

app.get("/api/knowledge/fingerprints", requireAuth, async (req: AuthedRequest, res) => {
  const rows = await prisma.fingerprint.findMany({ where: { userId: req.userId! }, orderBy: { last_seen: "desc" } });
  res.json({ success: true, data: rows.map(publicFingerprint), knowledge_db_version: KNOWLEDGE_DB_VERSION });
});

app.get("/api/knowledge/similar/:id", requireAuth, async (req: AuthedRequest, res) => {
  const found = await similarTo(req.userId!, Number(req.params.id));
  if (!found) return res.status(404).json({ success: false, error: "Fingerprint not found" });
  res.json({ success: true, data: { ...found, target: publicFingerprint(found.target) } });
});

// The only route to VALIDATED. Nothing in the analysis path can promote a record by itself.
app.post("/api/knowledge/fingerprints/:id/status", requireAuth, async (req: AuthedRequest, res) => {
  const { status, note } = req.body || {};
  const result = await setStatus(req.userId!, Number(req.params.id), status, note, await who(req));
  if (result.error) return res.status(400).json({ success: false, error: result.error });
  res.json({ success: true, data: publicFingerprint(result.row) });
});

// ---------- forensics data ----------
app.post("/api/images/:id/forensics", requireAuth, async (req: AuthedRequest, res) => {
  try {
    const imageFileId = Number(req.params.id);
    const { dataType, data } = req.body || {};
    if (!dataType || data === undefined) return res.status(400).json({ success: false, error: "dataType and data are required" });
    const image = await prisma.imageFile.findUnique({ where: { id: imageFileId } });
    if (!image) return res.status(404).json({ success: false, error: "Image file not found" });
    if (!(await verifyCaseOwnership(req.userId!, image.caseId)))
      return res.status(403).json({ success: false, error: "Access denied: You do not own this case" });
    const record = await prisma.forensicsData.upsert({
      where: { imageFileId_dataType: { imageFileId, dataType } },
      update: { data: JSON.stringify(data) },
      create: { imageFileId, dataType, data: JSON.stringify(data) },
    });
    if (dataType === "time_settings") await logEvent(image.caseId, await who(req), "Time settings changed", { filename: image.filename, detail: JSON.stringify(data) });
    res.json({ success: true, data: record });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

app.get("/api/images/:id/forensics", requireAuth, async (req: AuthedRequest, res) => {
  const imageFileId = Number(req.params.id);
  const image = await prisma.imageFile.findUnique({ where: { id: imageFileId } });
  if (!image) return res.status(404).json({ success: false, error: "Image file not found" });
  if (!(await verifyCaseOwnership(req.userId!, image.caseId)))
    return res.status(403).json({ success: false, error: "Access denied: You do not own this case" });
  const rows = await prisma.forensicsData.findMany({ where: { imageFileId } });
  const data: Record<string, any> = {};
  for (const r of rows) data[r.dataType] = JSON.parse(r.data);
  res.json({ success: true, data });
});

// Generic upload for tool inputs (video/image files fed to the python engine).
// Separate from case evidence: these are working files for a tool run, not chain-of-custody items.
app.post("/api/uploads", requireAuth, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: "file is required" });
  const dest = path.join(UPLOAD_DIR, `${Date.now()}-${req.file.originalname}`);
  fs.renameSync(req.file.path, dest);
  res.json({ success: true, path: dest, filename: req.file.originalname });
});

// ---------- outputs (serve the real files the engine writes to a case's output dir) ----------
const MEDIA_EXT = new Set([".mp4", ".avi", ".mkv", ".mov", ".png", ".jpg", ".jpeg"]);
const VIDEO_EXT = new Set([".mp4", ".avi", ".mkv", ".mov"]);

app.get("/api/outputs", requireAuth, (req, res) => {
  const dir = String(req.query.dir || "");
  if (!dir || !fs.existsSync(dir)) return res.json({ success: true, files: [] });
  const files = fs
    .readdirSync(dir)
    // .web.mp4 files are our own browser-preview cache (see /api/outputs/file below), not a distinct engine output.
    .filter((f) => MEDIA_EXT.has(path.extname(f).toLowerCase()) && !f.endsWith(".web.mp4"))
    .map((f) => {
      const full = path.join(dir, f);
      const stat = fs.statSync(full);
      return { name: f, path: full, mtimeMs: stat.mtimeMs, size: stat.size };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  res.json({ success: true, files });
});

// Serves a real output file by absolute path (same local-file trust model as the tool inputs
// themselves: this is a single-examiner desktop-style tool, not a multi-tenant public server).
app.get("/api/outputs/file", requireAuth, (req, res) => {
  const filePath = String(req.query.path || "");
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).end();

  // The engine writes video with codecs no browser <video> element can play (XVID-in-AVI from
  // DVR-Scan's OpenCV mode, mp4v-in-mp4 from the RF-DETR object-detection script). Transcode to
  // real H.264/mp4 for preview, cached next to the original; the original file is untouched.
  const ext = path.extname(filePath).toLowerCase();
  if (VIDEO_EXT.has(ext) && !filePath.endsWith(".web.mp4")) {
    const webPath = filePath.slice(0, -ext.length) + ".web.mp4";
    if (fs.existsSync(webPath) && fs.statSync(webPath).mtimeMs >= fs.statSync(filePath).mtimeMs) {
      return res.sendFile(webPath);
    }
    return execFile(
      FFMPEG_PATH,
      ["-y", "-i", filePath, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", webPath],
      (err) => {
        if (err) return res.status(500).json({ success: false, error: `Preview transcode failed: ${err.message}` });
        res.sendFile(webPath);
      }
    );
  }

  res.sendFile(filePath);
});

// ---------- tasks (motion / faces / objects / upscale via SSE, ocr synchronous) ----------
// Evidence tasks use database-owned paths and persist results before announcing completion.
app.post("/api/images/:id/tasks/:action", requireAuth, async (req: AuthedRequest, res) => {
  try {
    const imageId = Number(req.params.id);
    if (!Number.isInteger(imageId)) return res.status(400).json({ success: false, error: "Invalid image id" });
    const image = await prisma.imageFile.findUnique({ where: { id: imageId } });
    if (!image || !(await verifyCaseOwnership(req.userId!, image.caseId)))
      return res.status(403).json({ success: false, error: "Access denied" });
    const action = req.params.action;
    if (!["hash", "identify", "parse", "extract", "induce"].includes(action))
      return res.status(400).json({ success: false, error: "Unknown evidence action" });
    const work = path.join(OUTPUT_DIR, String(image.caseId), String(image.id), crypto.randomUUID());
    fs.mkdirSync(work, { recursive: true });
    const args = [action, "--image", image.path_on_disk, "--work", work];
    if (action === "extract") {
      const stored = await prisma.forensicsData.findUnique({ where: { imageFileId_dataType: { imageFileId: image.id, dataType: "parsed_bundle" } } });
      if (!stored) return res.status(400).json({ success: false, error: "Parse this evidence first" });
      const bundle = JSON.parse(stored.data);
      if (typeof req.body.recordingId !== "string" || !bundle.recordings?.some((r: any) => r.id === req.body.recordingId))
        return res.status(400).json({ success: false, error: "Unknown recording" });
      const bundlePath = path.join(work, "bundle.json");
      fs.writeFileSync(bundlePath, stored.data);
      args.push("--bundle", bundlePath, "--recording", req.body.recordingId);
    }
    const actor = await who(req);
    const detail = action === "extract" ? `recording ${req.body.recordingId}` : undefined;
    await logEvent(image.caseId, actor, `Task started: ${action}`, { filename: image.filename, sha256: image.hash_sha256, detail });
    const task = startTask(action, args, { module: "dvr_scan.forensics", userId: req.userId!, onResult: async (data) => {
      const records: Record<string, any> = action === "parse" ? { parsed_bundle: data, ...data } :
        { [action === "hash" ? "media_hashes" : action === "identify" ? "identification" : action === "induce" ? "induction" : `extraction_${req.body.recordingId}`]: data };
      if (action === "hash") {
        const fileHashes = await hashFile(image.path_on_disk);
        records.integrity = { expected_sha256: image.hash_sha256, current_sha256: fileHashes.sha256,
          matches: image.hash_sha256 ? fileHashes.sha256 === image.hash_sha256 : null, checked_at: new Date().toISOString() };
        await logEvent(image.caseId, actor, records.integrity.matches === false ? "Integrity check FAILED" : "Integrity check", { filename: image.filename, sha256: fileHashes.sha256,
          detail: records.integrity.matches === null ? "no intake hash to compare" : records.integrity.matches ? "matches the hash taken on upload" : `differs from the upload hash ${image.hash_sha256}` });
      } else await logEvent(image.caseId, actor, `Task finished: ${action}`, { filename: image.filename, detail });
      if (data?.fingerprint?.tokens?.length) {
        const seen = await observe(req.userId!, data.fingerprint,
          { caseId: image.caseId, imageFileId: image.id, filename: image.filename, sha256: image.hash_sha256, at: new Date().toISOString() },
          data.parser?.version ?? "unknown", actor);
        records.knowledge_match = { fingerprint_id: seen.row.id, label: seen.row.label, status: seen.row.status,
          confidence: seen.row.confidence, observations: seen.row.observations, matched_known_layout: seen.matched,
          best_match: seen.best, candidate_profiles: seen.candidates, knowledge_db_version: KNOWLEDGE_DB_VERSION,
          note: "A similar record is a lead, not an identification. Only an analyst can mark a layout validated." };
      }
      await prisma.$transaction(Object.entries(records).map(([dataType, value]) => prisma.forensicsData.upsert({
        where: { imageFileId_dataType: { imageFileId: image.id, dataType } },
        update: { data: JSON.stringify(value) }, create: { imageFileId: image.id, dataType, data: JSON.stringify(value) },
      })));
    } });
    res.json({ success: true, taskId: task.id });
  } catch (error) { res.status(500).json({ success: false, error: (error as Error).message }); }
});

app.post("/api/tasks/upscale-image", requireAuth, (req: AuthedRequest, res) => {
  const { image, scale = 2, method = "lanczos", caseId: rawCase } = req.body || {};
  const outputDir: string = typeof req.body?.outputDir === "string" && path.isAbsolute(req.body.outputDir) ? req.body.outputDir : resolveOutputDir(Number.isInteger(rawCase) ? rawCase : null).dir;
  if (typeof image !== "string" || ![2, 3, 4].includes(scale) || !["lanczos", "upscayl"].includes(method))
    return res.status(400).json({ success: false, error: "Choose an image and a scale of 2, 3 or 4" });
  const problem = folderProblem(outputDir);
  if (problem) return res.status(400).json({ success: false, error: `Cannot write to the output folder "${outputDir}". ${problem}` });
  const task = startTask("upscale", ["upscale", "--image", image, "--work", outputDir, "--scale", String(scale), "--method", method],
    { module: "dvr_scan.forensics", userId: req.userId! });
  res.json({ success: true, taskId: task.id });
});

// Fail fast with a readable message instead of letting the engine die on a Python traceback.
function ensureWritableDir(dir: unknown): void {
  if (typeof dir !== "string" || !dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    throw new Error(`Cannot write to the output folder "${dir}". It may not exist on this computer or you may lack permission. Choose another folder under Global output directory.`);
  }
}

function buildArgs(kind: string, s: any): string[] {
  const args: string[] = [];
  ensureWritableDir(s.outputDir ?? s.output_dir ?? (typeof s.output === "string" ? path.dirname(s.output) : undefined));
  switch (kind) {
    case "motion": {
      args.push("scan");
      for (const i of s.input || []) args.push("-i", i);
      if (s.threshold !== undefined) args.push("-t", String(s.threshold));
      if (s.minEventLength !== undefined) args.push("-l", String(s.minEventLength));
      if (s.scanOnly) args.push("-so");
      if (s.outputMode) args.push("-m", s.outputMode);
      if (s.outputDir) args.push("-d", s.outputDir);
      if (s.boundingBox) args.push("-bb");
      if (s.timeCode) args.push("-tc");
      if (s.frameMetrics) args.push("-fm");
      if (s.frameSkip !== undefined) args.push("-fs", String(s.frameSkip));
      if (s.downscaleFactor !== undefined) args.push("-df", String(s.downscaleFactor));
      if (s.regionOfInterest) args.push("-roi", s.regionOfInterest);
      return args;
    }
    case "faces": {
      args.push("criminal-detection", s.task || "index", s.video_path);
      if (s.output_dir) args.push("--output-dir", s.output_dir);
      if (s.task === "recognize" && s.index_dir) args.push("--index-dir", s.index_dir);
      return args;
    }
    case "objects": {
      args.push("object-detection");
      const model = s.model || "base";
      // ponytail: RF-DETR caches its pretrained weights under ~/.roboflow/models/rf-detr-<model>.pth
      // on first download (see engine/download_object_model.py); reuse that cache by default so the
      // frontend doesn't need to know a local weights path. Override with an explicit `weights` field.
      // Packaged app: weights ship in <engine>/models/rfdetr so nothing is read from the user's profile.
      const shipped = path.join(ENGINE_DIR, "models", "rfdetr", `rf-detr-${model}.pth`);
      const defaultWeights = fs.existsSync(shipped) ? shipped : path.join(os.homedir(), ".roboflow", "models", `rf-detr-${model}.pth`);
      args.push("--weights", s.weights || defaultWeights);
      args.push("--model", model);
      if (s.video) args.push("--video", s.video);
      if (s.output) args.push("--output", s.output);
      return args;
    }
    case "upscale": {
      args.push("upscale");
      if (s.image) args.push("--image", s.image);
      if (s.model) args.push("--model", s.model);
      if (s.output) args.push("--output", s.output);
      return args;
    }
    default:
      throw new Error(`Unknown task kind: ${kind}`);
  }
}

// OCR: single-shot spawn, parse one JSON line from stdout (production branch of ocr:perform).
// Registered before the generic /:kind route so it isn't swallowed by that param match.
app.post("/api/tasks/ocr", requireAuth, async (req, res) => {
  if (req.body?.video) {
    const { video, sampleRate = 1, confidence = 0.8, caseId: rawCase } = req.body;
    const outputDir: string = typeof req.body.outputDir === "string" && path.isAbsolute(req.body.outputDir) ? req.body.outputDir : resolveOutputDir(Number.isInteger(rawCase) ? rawCase : null).dir;
    if (typeof video !== "string" || !path.isAbsolute(outputDir) ||
        !Number.isFinite(sampleRate) || sampleRate <= 0 || sampleRate > 60 ||
        !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return res.status(400).json({ success: false, error: "Choose a video, a sample rate (0–60), and a confidence (0–1)." });
    }
    const outputProblem = folderProblem(outputDir);
    if (outputProblem) return res.status(400).json({ success: false, error: `Cannot write to the output folder "${outputDir}". ${outputProblem}` });
    const output = path.join(outputDir, `ocr-${crypto.randomUUID()}.mp4`);
    const task = runOcrVideo(video, output, sampleRate, confidence);
    return res.json({ success: true, taskId: task.id });
  }
  const { image } = req.body || {};
  if (!image) return res.status(400).json({ success: false, error: "image is required" });
  const result = await runOcrImage(image);
  res.json(result);
});

// "HH:MM:SS.mmm" as written by the motion scanner, to seconds.
const clockSeconds = (t: string) => t.split(":").reduce((n, part) => n * 60 + Number(part), 0);

/** Pull a task's findings out of its final engine event into the shape Analytics and Correlation read. */
function readFindings(kind: string, event: any): { appearances: any[]; duration_s?: number; output?: string } | null {
  if (kind === "motion" && event?.type === "complete" && Array.isArray(event.events))
    return { appearances: event.events.map((e: any) => ({ class: "Motion", start_s: clockSeconds(e.start), end_s: clockSeconds(e.end) })) };
  if (kind === "objects" && event?.type === "object_detection_complete" && event.success) {
    let detail: any = {};
    try { detail = JSON.parse(fs.readFileSync(event.detections_path, "utf8")); } catch { /* older engine: no sidecar */ }
    return { appearances: detail.appearances ?? [], duration_s: detail.duration_s, output: event.output_path };
  }
  if (kind === "faces" && event?.type === "criminal_detection_complete" && event.success)
    return { appearances: [], output: event.output_path }; // the face tool writes an annotated video, not a list
  return null;
}

app.post("/api/tasks/:kind", requireAuth, async (req: AuthedRequest, res) => {
  const kind = req.params.kind;
  if (!["motion", "faces", "objects", "upscale"].includes(kind)) {
    return res.status(400).json({ success: false, error: "kind must be one of motion, faces, objects, upscale" });
  }
  try {
    const body = req.body || {};
    // Optional: tie the run to a case, and to a recovered clip so its real recording time is known.
    const caseId = Number.isInteger(body.caseId) ? Number(body.caseId) : null;
    if (caseId !== null && !(await verifyCaseOwnership(req.userId!, caseId)))
      return res.status(403).json({ success: false, error: "Access denied: You do not own this case" });
    let clip: { imageFileId: number; recordingId: string; channel: number | null; start: string | null; end: string | null; path: string } | null = null;
    if (caseId !== null && body.clip) {
      const image = await prisma.imageFile.findUnique({ where: { id: Number(body.clip.imageId) } });
      if (!image || image.caseId !== caseId) return res.status(400).json({ success: false, error: "That clip is not in this case" });
      const rows = await prisma.forensicsData.findMany({ where: { imageFileId: image.id, dataType: { in: ["parsed_bundle", `extraction_${body.clip.recordingId}`] } } });
      const bundle = JSON.parse(rows.find((r) => r.dataType === "parsed_bundle")?.data ?? "{}");
      const out = JSON.parse(rows.find((r) => r.dataType !== "parsed_bundle")?.data ?? "{}").output;
      const rec = bundle.recordings?.find((r: any) => r.id === body.clip.recordingId);
      if (!rec || !out || !fs.existsSync(out)) return res.status(400).json({ success: false, error: "Recover that recording first" });
      clip = { imageFileId: image.id, recordingId: rec.id, channel: rec.channel ?? null, start: rec.start ?? null, end: rec.end ?? null, path: out };
      // The tool reads the recovered file, whatever the client sent as the input.
      if (kind === "motion") body.input = [out]; else if (kind === "objects") body.video = out; else if (kind === "faces") body.video_path = out;
    }
    withOutputDefaults(kind, body, resolveOutputDir(caseId).dir);
    const args = buildArgs(kind, body);
    const task = startTask(kind, args);
    if (caseId !== null && kind !== "upscale") {
      const actor = await who(req);
      const source = path.basename(clip?.path ?? body.video ?? body.video_path ?? body.input?.[0] ?? "clip");
      await logEvent(caseId, actor, `Analysis started: ${kind}`, { filename: source, detail: clip ? `recording ${clip.recordingId}, channel ${clip.channel ?? "unknown"}` : "uploaded file, recording time unknown" });
      task.emitter.on("event", async (event: any) => {
        const findings = event.channel === "update" || event.channel === "log" ? readFindings(kind, event.data) : null;
        if (!findings) return;
        try {
          await prisma.analysisResult.create({ data: { caseId, kind, source, imageFileId: clip?.imageFileId, recordingId: clip?.recordingId,
            channel: clip?.channel, clip_start: clip?.start, clip_end: clip?.end, data: JSON.stringify(findings) } });
          await logEvent(caseId, actor, `Analysis finished: ${kind}`, { filename: source, detail: `${findings.appearances.length} finding(s)` });
        } catch (error) { console.error("[pramaan-backend] could not save analysis:", (error as Error).message); }
      });
    }
    res.json({ success: true, taskId: task.id });
  } catch (error) {
    res.status(400).json({ success: false, error: (error as Error).message });
  }
});

app.get("/api/tasks/:id/stream", requireAuth, (req: AuthedRequest, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).end();
  if (task.userId !== undefined && task.userId !== req.userId) return res.status(403).end();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (event: { channel: string; data: any }) => {
    if (res.writableEnded || res.destroyed) return; // client left or stream already closed
    res.write(`event: ${event.channel}\n`);
    res.write(`data: ${JSON.stringify(event.data)}\n\n`);
  };

  for (const evt of task.buffer) send(evt);
  if (task.done) return res.end();

  const listener = (evt: any) => {
    send(evt);
    if (evt.channel === "complete" || evt.channel === "error") {
      task.emitter.off("event", listener);
      res.end();
    }
  };
  task.emitter.on("event", listener);
  req.on("close", () => task.emitter.off("event", listener));
});

// ---------- assistant (Sahayak) ----------
// Conversational, read-only. The model gets the screen snapshot the frontend
// sends plus the lookups in src/chat/tools.ts, and nothing that can write.
// The assistant needs an API key and the internet. The interface asks first and hides the button when it cannot work.
// The key comes from backend/.env in development; an installed copy has no .env, so the examiner pastes their own
// key into the panel once and it is kept in the data folder. It is never bundled: a key inside a public installer
// would be free for anyone to extract and spend.
const KEY_FILE = path.join(STORAGE_DIR, "groq.key");
try {
  if (!process.env.GROQ_API_KEY && fs.existsSync(KEY_FILE)) process.env.GROQ_API_KEY = fs.readFileSync(KEY_FILE, "utf8").trim();
} catch { /* unreadable key file: the panel will ask again */ }

app.get("/api/chat/status", (_req, res) => res.json({ success: true, configured: Boolean(process.env.GROQ_API_KEY) }));

app.put("/api/chat/key", requireAuth, (req, res) => {
  const key = String((req.body || {}).key ?? "").trim();
  if (!/^gsk_[A-Za-z0-9]{20,}$/.test(key)) {
    return res.status(400).json({ success: false, error: "That does not look like a Groq key. It starts with gsk_ (create one free at console.groq.com/keys)." });
  }
  fs.writeFileSync(KEY_FILE, key, { mode: 0o600 });
  process.env.GROQ_API_KEY = key;
  res.json({ success: true });
});

app.post("/api/chat/query", requireAuth, async (req: AuthedRequest, res) => {
  const { messages, context } = (req.body || {}) as { messages?: InboundMessage[]; context?: unknown };
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ success: false, error: "messages must not be empty" });
  }
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      success: false,
      error: "The assistant needs a Groq API key. Add one in the assistant panel.",
    });
  }

  try {
    const reply = await answer({
      // Only role and content cross into the prompt — the widget sends nothing
      // else, but it is the client, so don't take its word for the shape.
      messages: messages
        .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .map((m) => ({ role: m.role, content: m.content })),
      liveContext: context,
      userId: req.userId!,
      apiKey,
    });
    res.json({
      success: true,
      reply: reply.answer || "I couldn't put an answer together for that. Try asking it a different way.",
      model: reply.model,
      toolsUsed: reply.toolsUsed,
    });
  } catch (error) {
    if (error instanceof AllModelsBusy) {
      const wait = (error as AllModelsBusy).retryAfterSec;
      res.setHeader("Retry-After", String(wait));
      return res.status(503).json({
        success: false,
        error: `The assistant has hit its usage limit for the moment. Try again in about ${wait} seconds.`,
      });
    }
    if (error instanceof ChatNotConfigured) {
      return res.status(503).json({ success: false, error: (error as Error).message });
    }
    res.status(502).json({ success: false, error: `Assistant request failed: ${(error as Error).message}` });
  }
});

// One bad request must never take the whole backend down.
process.on("unhandledRejection", (e) => console.error("[pramaan-backend] unhandled rejection:", e instanceof Error ? e.message : e));

// In the desktop build the compiled frontend is served from this same origin, so the window talks to
// a relative /api and there is no port to inject or CORS to configure.
const FRONTEND_DIR = process.env.FRONTEND_DIR;
if (FRONTEND_DIR && fs.existsSync(FRONTEND_DIR)) {
  app.use(express.static(FRONTEND_DIR));
  // Hash routing means every deep link is still index.html.
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(FRONTEND_DIR, "index.html")));
}

// PORT=0 asks the OS for a free port, so a desktop install never collides with whatever else
// is on 4000. The chosen port is printed as JSON for the Electron shell to read.
const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
const server = app.listen(PORT, "127.0.0.1", () => {
  const actual = (server.address() as import("net").AddressInfo).port;
  console.log(`[pramaan-backend] listening on http://127.0.0.1:${actual}`);
  console.log(`PRAMAAN_PORT=${actual}`);
});
// Pays the OCR engine's ~30s Python/model warm-up cost now, in the background, instead of on
// whoever's first real request.
warmOcrWorker();
