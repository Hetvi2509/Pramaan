// Keeps one long-lived Python OCR process warm (PaddleOCR import + model load is ~30s) so that
// only the actual per-video inference cost (~1-2s/frame) is paid per request, instead of the
// full ~30s+ startup cost that a fresh `python -m dvr_scan ocr ...` spawn pays every single time
// (see engine/ocr_worker.py for the stdin/stdout job protocol). Jobs run one at a time; concurrent
// requests queue rather than spawning a second heavy process.
import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import * as path from "path";
import { classify, createTask, ENGINE_DIR, PYTHON_EXE, SPAWN_ENV, type EngineEvent, type Task } from "./engine";

interface Job {
  payload: Record<string, unknown>; // sent to the Python worker as-is; its own "cmd" field says video/image
  push: (event: EngineEvent) => void;
  finish: (success: boolean, message: string) => void;
}

let worker: ChildProcessWithoutNullStreams | null = null;
let ready = false;
let current: Job | null = null;
const queue: Job[] = [];
let pending = "";

function spawnWorker() {
  worker = spawn(PYTHON_EXE, ["-u", path.join(ENGINE_DIR, "ocr_worker.py")], { cwd: ENGINE_DIR, env: SPAWN_ENV });
  ready = false;
  worker.stdout.setEncoding("utf8");
  worker.stdout.on("data", onData);
  worker.stderr.on("data", () => {
    /* PaddleOCR's own startup warnings/logs; the SSE log panel doesn't need them. */
  });
  worker.on("exit", () => {
    worker = null;
    ready = false;
    const failed = [current, ...queue];
    current = null;
    queue.length = 0;
    for (const job of failed) job?.finish(false, "The OCR worker process exited unexpectedly.");
  });
}

function onData(chunk: string) {
  pending += chunk;
  const lines = pending.split("\n");
  pending = lines.pop()!;
  for (const line of lines) {
    if (!line.trim()) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // stray non-JSON stdout (paddle banners etc.), nothing to route it to
    }
    if (parsed.type === "worker_ready") {
      ready = true;
      startNext();
      continue;
    }
    if (!current) continue;
    current.push({ channel: classify(parsed.type || ""), data: parsed });
    if (parsed.type === "ocr_complete") {
      current.finish(true, "The video with detected text boxes is ready.");
      current = null;
      startNext();
    } else if (parsed.type === "error") {
      current.finish(false, parsed.message || "OCR failed");
      current = null;
      startNext();
    }
  }
}

function startNext() {
  if (current || !ready || !worker || queue.length === 0) return;
  current = queue.shift()!;
  worker.stdin.write(JSON.stringify(current.payload) + "\n");
}

function enqueue(payload: Record<string, unknown>, push: (event: EngineEvent) => void, finish: (success: boolean, message: string) => void) {
  if (!worker) spawnWorker();
  queue.push({ payload, push, finish });
  startNext();
}

/** Pre-spawns the worker (call once at server startup) so the first real request isn't the one paying the warm-up cost. */
export function warmOcrWorker() {
  if (!worker) spawnWorker();
}

export function runOcrVideo(video: string, output: string, sampleRate: number, confidence: number, userId?: number): Task {
  const { task, push, finish } = createTask("ocr", userId);
  enqueue({ cmd: "video", video, output, sampleRate, confidence }, push, finish);
  return task;
}

export function runOcrImage(image: string, userId?: number): Promise<{ success: boolean; data?: unknown; error?: string }> {
  return new Promise((resolve) => {
    const { push, finish } = createTask("ocr", userId);
    let data: unknown;
    enqueue(
      { cmd: "image", image },
      (event) => {
        push(event);
        if (event.channel === "update") data = event.data;
      },
      (success, message) => {
        finish(success, message);
        resolve(success ? { success: true, data } : { success: false, error: message });
      }
    );
  });
}
