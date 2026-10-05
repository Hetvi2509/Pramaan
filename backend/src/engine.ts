// Port of Niriksha's runPythonEngine (electron-main.ts) to a spawn+SSE model.
import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { EventEmitter } from "events";
import { randomUUID } from "crypto";

export const ENGINE_DIR = path.join(__dirname, "..", "engine");
const VENV_PYTHON =
  process.platform === "win32"
    ? path.join(ENGINE_DIR, ".venv", "Scripts", "python.exe")
    : path.join(ENGINE_DIR, ".venv", "bin", "python");
export const PYTHON_EXE = fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : process.env.PYTHON_EXE || "python";
// Run as `python -m dvr_scan` (not the __main__.py path directly) so relative imports resolve
// the same way the reference Electron app's dev-mode invocation did.
const ENGINE_MODULE_ARGS = ["-m", "dvr_scan"];
// ffmpeg.exe (from imageio-ffmpeg) lives in ENGINE_DIR so dvr-scan's ffmpeg output mode can find it.
export const SPAWN_ENV = { ...process.env, PATH: `${ENGINE_DIR}${path.delimiter}${process.env.PATH ?? ""}` };

export type EngineEvent =
  | { channel: "log"; data: string }
  | { channel: "update"; data: any }
  | { channel: "complete"; data: { success: boolean; code: number | null; message: string } }
  | { channel: "error"; data: string };

export interface Task {
  id: string;
  kind: string;
  emitter: EventEmitter;
  buffer: EngineEvent[];
  done: boolean;
  userId?: number;
}

const tasks = new Map<string, Task>();

/** A Task not backed by a spawned process — the caller pushes events itself (used by the warm OCR worker). */
export function createTask(kind: string, userId?: number) {
  const id = randomUUID();
  const emitter = new EventEmitter();
  const task: Task = { id, kind, emitter, buffer: [], done: false, userId };
  tasks.set(id, task);
  const push = (event: EngineEvent) => {
    task.buffer.push(event);
    emitter.emit("event", event);
  };
  const finish = (success: boolean, message: string) => {
    push({ channel: "complete", data: { success, code: success ? 0 : 1, message } });
    if (!success) push({ channel: "error", data: message });
    task.done = true;
  };
  return { task, push, finish };
}

export function classify(type: string): "log" | "update" {
  if (
    type.startsWith("scan_") ||
    type === "progress" ||
    type === "complete" ||
    type.startsWith("criminal_detection") ||
    type.startsWith("object_detection") ||
    type.startsWith("ocr_") ||
    type.startsWith("forensics_") ||
    type.startsWith("upscale_")
  ) {
    return "update";
  }
  return "log";
}

/** Spawn the dvr-scan-py CLI with the given subcommand args, streaming JSON-lines as engine events. */
export function startTask(kind: string, taskArgs: string[], options: {
  module?: string; userId?: number; onResult?: (result: any) => Promise<void>;
} = {}): Task {
  const id = randomUUID();
  const emitter = new EventEmitter();
  const task: Task = { id, kind, emitter, buffer: [], done: false };
  tasks.set(id, task);
  task.userId = options.userId;
  let result: any;

  const push = (event: EngineEvent) => {
    task.buffer.push(event);
    emitter.emit("event", event);
  };

  const command = PYTHON_EXE;
  const finalArgs = options.module ? ["-m", options.module, ...taskArgs] : [...ENGINE_MODULE_ARGS, ...taskArgs];

  push({ channel: "log", data: `[ENGINE] Spawning: ${command} ${finalArgs.join(" ")}` });

  const child = spawn(command, finalArgs, { cwd: ENGINE_DIR, env: SPAWN_ENV });

  let pending = "";
  const consume = (chunk: string, flush = false) => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = flush ? "" : lines.pop()!;
    lines
      .filter((l) => l.trim() !== "")
      .forEach((line) => {
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === "forensics_result") result = parsed.data;
          // A tool that says it finished but never wrote the file it names did not finish. The object tool does this when it
          // cannot read the video: it prints an error, then still reports success.
          if (/_complete$/.test(String(parsed.type)) && parsed.success === true && typeof parsed.output_path === "string" && !fs.existsSync(parsed.output_path)) {
            parsed.type = String(parsed.type).replace(/_complete$/, "_error");
            parsed.success = false;
            parsed.error = "The tool finished but did not write its output file, which usually means it could not read the input video.";
          }
          const type = parsed.type || "";
          push({ channel: classify(type), data: parsed });
        } catch {
          push({ channel: "log", data: `[PYTHON LOG] ${line}` });
        }
      });
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => consume(chunk));
  child.stdout.on("end", () => consume("", true));

  child.stderr.on("data", (buf: Buffer) => {
    push({ channel: "log", data: `[PYTHON STDERR] ${buf.toString()}` });
  });

  child.on("close", async (code) => {
    console.log(`[engine] ${kind} finished with exit code ${code}`);
    try {
      if (code === 0 && options.onResult) {
        if (result === undefined) throw new Error("Engine returned no result");
        await options.onResult(result);
      }
    } catch (error) {
      push({ channel: "error", data: `Could not save task result: ${(error as Error).message}` });
      task.done = true;
      return;
    }
    push({
      channel: "complete",
      data: { success: code === 0, code, message: `Process exited with code ${code}` },
    });
    if (code !== 0) {
      push({ channel: "error", data: `Process exited with non-zero exit code: ${code}` });
    }
    task.done = true;
  });

  child.on("error", (err: Error) => {
    push({ channel: "error", data: `Failed to start the Python engine: ${err.message}` });
    task.done = true;
  });

  return task;
}

export function getTask(id: string): Task | undefined {
  return tasks.get(id);
}

/** Simplified single-shot run: resolves once the process exits, returning the last parsed JSON line (used by OCR). */
export function runOnce(taskArgs: string[]): Promise<{ success: boolean; data?: any; error?: string }> {
  return new Promise((resolve) => {
    const command = PYTHON_EXE;
    const finalArgs = [...ENGINE_MODULE_ARGS, ...taskArgs];
    const child = spawn(command, finalArgs, { cwd: ENGINE_DIR, env: SPAWN_ENV });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      if (code === 0) {
        const jsonLine = stdout.split("\n").find((l) => l.trim().startsWith("{"));
        if (!jsonLine) return resolve({ success: false, error: `No JSON output. Stderr: ${stderr}` });
        try {
          resolve({ success: true, data: JSON.parse(jsonLine) });
        } catch (e) {
          resolve({ success: false, error: "Failed to parse engine JSON output." });
        }
      } else {
        resolve({ success: false, error: `Engine exited with code ${code}. Stderr: ${stderr}` });
      }
    });
    child.on("error", (err: Error) => resolve({ success: false, error: `Failed to start engine: ${err.message}` }));
  });
}
