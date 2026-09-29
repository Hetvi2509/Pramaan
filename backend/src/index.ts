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
import { startTask, getTask, ENGINE_DIR } from "./engine";
import { runOcrVideo, runOcrImage, warmOcrWorker } from "./ocrWorker";

const FFMPEG_PATH = path.join(ENGINE_DIR, "ffmpeg.exe");

const SALT_ROUNDS = 10;
const STORAGE_DIR = process.env.STORAGE_DIR ? path.resolve(process.env.STORAGE_DIR) : path.join(__dirname, "..");
const UPLOAD_DIR = path.join(STORAGE_DIR, "uploads");
const OUTPUT_DIR = path.join(STORAGE_DIR, "outputs");
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

    const image = await prisma.imageFile.create({
      data: { path_on_disk: filePath, filename, caseId, hash_sha256: hash.sha256, size_bytes: req.file.size,
        forensics: { create: { dataType: "intake_hashes", data: JSON.stringify({ ...hash, scope: "uploaded file bytes", size_bytes: req.file.size }) } } },
    });
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
    if (!["hash", "identify", "parse", "extract"].includes(action))
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
    const task = startTask(action, args, { module: "dvr_scan.forensics", userId: req.userId!, onResult: async (data) => {
      const records: Record<string, any> = action === "parse" ? { parsed_bundle: data, ...data } :
        { [action === "hash" ? "media_hashes" : action === "identify" ? "identification" : `extraction_${req.body.recordingId}`]: data };
      if (action === "hash") {
        const fileHashes = await hashFile(image.path_on_disk);
        records.integrity = { expected_sha256: image.hash_sha256, current_sha256: fileHashes.sha256,
          matches: image.hash_sha256 ? fileHashes.sha256 === image.hash_sha256 : null, checked_at: new Date().toISOString() };
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
  const { image, scale = 2, outputDir, method = "lanczos" } = req.body || {};
  if (typeof image !== "string" || ![2, 3, 4].includes(scale) || !["lanczos", "upscayl"].includes(method) || typeof outputDir !== "string" || !path.isAbsolute(outputDir))
    return res.status(400).json({ success: false, error: "Choose an image, absolute output folder and scale 2, 3 or 4" });
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
      const defaultWeights = path.join(os.homedir(), ".roboflow", "models", `rf-detr-${model}.pth`);
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
    const { video, outputDir, sampleRate = 1, confidence = 0.8 } = req.body;
    if (typeof video !== "string" || typeof outputDir !== "string" || !path.isAbsolute(outputDir) ||
        !Number.isFinite(sampleRate) || sampleRate <= 0 || sampleRate > 60 ||
        !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return res.status(400).json({ success: false, error: "Choose an absolute output folder, sample rate (0–60), and confidence (0–1)." });
    }
    const output = path.join(outputDir, `ocr-${crypto.randomUUID()}.mp4`);
    const task = runOcrVideo(video, output, sampleRate, confidence);
    return res.json({ success: true, taskId: task.id });
  }
  const { image } = req.body || {};
  if (!image) return res.status(400).json({ success: false, error: "image is required" });
  const result = await runOcrImage(image);
  res.json(result);
});

app.post("/api/tasks/:kind", requireAuth, (req, res) => {
  const kind = req.params.kind;
  if (!["motion", "faces", "objects", "upscale"].includes(kind)) {
    return res.status(400).json({ success: false, error: "kind must be one of motion, faces, objects, upscale" });
  }
  try {
    const args = buildArgs(kind, req.body || {});
    const task = startTask(kind, args);
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

// One bad request must never take the whole backend down.
process.on("unhandledRejection", (e) => console.error("[pramaan-backend] unhandled rejection:", e instanceof Error ? e.message : e));

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
app.listen(PORT, () => console.log(`[pramaan-backend] listening on http://localhost:${PORT}`));
// Pays the OCR engine's ~30s Python/model warm-up cost now, in the background, instead of on
// whoever's first real request.
warmOcrWorker();
