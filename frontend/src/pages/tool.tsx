import { useEffect, useRef, useState } from "react"
import { useParams } from "react-router-dom"
import { DownloadSimpleIcon, FileVideoIcon, UploadSimpleIcon, XIcon } from "@phosphor-icons/react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { LogPanel, OutputDir, useOutputDir, useTaskRun } from "@/components/pramaan/tool-bits"
import { PageHeader } from "@/components/pramaan/page-header"
import { SurveillancePlayer } from "@/components/pramaan/video-player"
import { api } from "@/lib/api"

type F = { id: string; label: string; value: string; options?: string[]; hint?: string }
interface Tool {
  title: string
  description: string
  drop: string
  files: string[]
  scan: F[]
  checks: string[]
  perf: F[]
  roi?: string
  run: string
  dry?: string
  note?: string
  out?: true
  log: string[]
  done: string
}

const vid = "video_block_at_7684c5e000.avi"
const stderr = (p: number, n: number, fps: string) => `[PYTHON STDERR] Detected: 1 | Progress: ${String(p).padStart(3)}% | ${n}/197 [00:01<00:00, ${fps} frames/s]`

type ToolKind = "motion" | "ocr" | "faces" | "objects" | "upscale"
const tools: Record<ToolKind, Tool> = {
  motion: {
    title: "Motion detection",
    description: "Scans recovered video for movement and writes each event with its start and end time.",
    drop: "Select video files for motion detection analysis",
    files: [vid],
    scan: [
      { id: "th", label: "Threshold", value: "0.15" },
      { id: "min", label: "Min event length (s)", value: "0.1" },
      { id: "mode", label: "Output mode", value: "OpenCV (.avi)", options: ["OpenCV (.avi)", "FFmpeg (.mp4)"], hint: "Overlays below only draw in OpenCV mode; FFmpeg mode is a faster raw clip with no annotations." },
    ],
    checks: ["Draw bounding box", "Draw timecode", "Draw frame metrics"],
    perf: [
      { id: "skip", label: "Frame skip", value: "0" },
      { id: "down", label: "Downscale factor", value: "1" },
    ],
    roi: "e.g. 100 100 800 100 800 600 100 600",
    run: "Start scan",
    dry: "Scan only (no output files)",
    out: true,
    log: [stderr(76, 150, "139.35"), stderr(84, 165, "139.71"), stderr(91, 180, "140.78"), stderr(99, 195, "138.41"), stderr(100, 197, "132.20"),
      "[PYTHON LOG] [DVR-Scan] Detected 1 motion events in input.", "Detected events:", "  - Event 1: 00:00:00.066 to 00:00:06.540", "[PROCESS] Process exited with code 0"],
    done: "The task finished successfully.",
  },
  ocr: {
    title: "OCR analysis",
    description: "Finds text in your video and outlines the detected text in the output video.",
    drop: "Select video files for OCR analysis",
    files: [vid],
    scan: [
      { id: "rate", label: "Sample rate (frames/s)", value: "1" },
    ],
    checks: [],
    perf: [{ id: "conf", label: "Min confidence", value: "0.80" }],
    run: "Start OCR",
    out: true,
    note: "Green boxes mark detected text. Boxes update at the selected sample rate; increase it for moving text. The output preview has no audio.",
    log: [],
    done: "The video with detected text boxes is ready.",
  },
  faces: {
    title: "Face detection",
    description: "Finds faces in person crops and groups them. The result is a lead for the examiner, never an identification.",
    drop: "Select video files for face detection",
    files: [vid],
    scan: [
      { id: "tol", label: "Match tolerance", value: "0.60", hint: "Lower is stricter" },
      { id: "min", label: "Min face size (px)", value: "24" },
      { id: "mode", label: "Watch list", value: "None (cluster only)", options: ["None (cluster only)", "Reference photos"] },
    ],
    checks: ["Run on full-resolution person crops", "Skip clips that failed the quality gate"],
    perf: [{ id: "skip", label: "Frame skip", value: "5" }],
    run: "Start detection",
    out: true,
    note: "Faces are leads, not identification. Every hit is labelled with whether the footage was live, deleted or repaired.",
    log: ["[PYTHON LOG] INFO: Loaded 197 frames, 1 person track", "[FACES] Cropping persons at full resolution", "[FACES] 3 faces found in 3 frames", "[FACES] DBSCAN eps=0.60 → 1 cluster",
      "[PYTHON LOG] INFO: Wrote 1 cluster folder and annotated video", "[PROCESS] Process exited with code 0"],
    done: "3 faces in 1 cluster.",
  },
  objects: {
    title: "Object detection",
    description: "Detects people, vehicles and bags in recovered video and records each detection with a time and confidence.",
    drop: "Select video files for object detection",
    files: [vid],
    scan: [
      { id: "model", label: "Model", value: "RF-DETR Nano", options: ["RF-DETR Nano", "RF-DETR Base (slower, more accurate)"] },
      { id: "conf", label: "Confidence", value: "0.50" },
      { id: "cls", label: "Classes", value: "Person, vehicle, bag", options: ["Person, vehicle, bag", "Person only", "All classes"] },
    ],
    checks: ["Draw bounding box", "Draw class label"],
    perf: [{ id: "fps", label: "Sample rate (frames/s)", value: "1" }],
    run: "Start detection",
    out: true,
    log: ["[PYTHON LOG] INFO: RF-DETR Nano loaded (ONNX, CPU)", "[OBJECTS] Sampling 1 frame/s: 197 frames", "[OBJECTS] person 0.94 tracked 00:00:00.0 to 00:00:06.5", "[OBJECTS] backpack 0.78 tracked 00:00:00.0 to 00:00:06.5", "[OBJECTS] car 0.88 (whole clip)",
      "[PYTHON LOG] INFO: 3 objects written to database, annotated video saved", "[PROCESS] Process exited with code 0"],
    done: "3 objects tracked.",
  },
  upscale: {
    title: "Image upscaling",
    description: "Enlarges an image and saves a separate PNG with MD5 and SHA-256 hashes.",
    drop: "Select images or frames to upscale",
    files: ["frame_000412.png"],
    scan: [
      { id: "scale", label: "Scale", value: "2×", options: ["2×", "3×", "4×"] },
      { id: "method", label: "Method", value: "Lanczos interpolation", options: ["Lanczos interpolation", "Upscayl Lite (AI)"] },
    ],
    checks: [],
    perf: [],
    run: "Start upscaling",
    out: true,
    note: "Interpolation cannot recover missing detail. AI output is watermarked as illustrative. Your original image is preserved. The Upscayl (AI) method needs a graphics driver with Vulkan support; Lanczos works on any machine.",
    log: ["[PYTHON LOG] INFO: Registering 8 neighbouring frames", "[UPSCALE] Sub-pixel alignment error 0.12 px", "[UPSCALE] Averaging → 2× output", `[PYTHON LOG] INFO: Saved frame_000412_x2.png`, "[PROCESS] Process exited with code 0"],
    done: "The upscaled image is ready.",
  },
}

function FieldInput({ f, value, onChange }: { f: F; value: string; onChange: (v: string) => void }) {
  return (
    <Field>
      <FieldLabel htmlFor={f.id}>{f.label}</FieldLabel>
      {f.options ? (
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger id={f.id} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {f.options.map((o) => (
              <SelectItem key={o} value={o}>
                {o}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input id={f.id} value={value} onChange={(e) => onChange(e.target.value)} inputMode="decimal" className="tnum" />
      )}
      {f.hint && <FieldDescription>{f.hint}</FieldDescription>}
    </Field>
  )
}

type UploadedFile = { name: string; path: string }
type RecoveredClip = { key: string; imageId: number; recordingId: string; label: string }

/** Recordings already recovered and decode-checked in this case: their channel and recorder time are known. */
function useRecoveredClips(caseId: string) {
  const [clips, setClips] = useState<RecoveredClip[]>([])
  useEffect(() => {
    let live = true
    ;(async () => {
      const found: RecoveredClip[] = []
      for (const image of (await api.listImages(caseId)).data) {
        const data: any = (await api.getForensics(image.id)).data
        for (const r of data.recordings ?? []) {
          const ex = data[`extraction_${r.id}`]
          if (ex?.output && ex.gate?.result === "passed")
            found.push({ key: `${image.id}:${r.id}`, imageId: image.id, recordingId: r.id,
              label: `${image.filename} · ${r.channel != null ? `channel ${r.channel}` : "channel unknown"} · ${r.start ?? "time unknown"}` })
        }
      }
      if (live) setClips(found)
    })().catch(() => {})
    return () => { live = false }
  }, [caseId])
  return clips
}

// Map a tool's field values + uploaded input paths to the backend task settings shape
// (see backend/src/index.ts buildArgs, ported from Niriksha's electron-main.ts IPC listeners).
function buildSettings(tool: ToolKind, files: UploadedFile[], values: Record<string, string>, checks: Record<string, boolean>, dry: boolean, dir: string | null) {
  const on = (word: string) => Object.entries(checks).find(([k]) => k.toLowerCase().includes(word))?.[1] ?? false
  switch (tool) {
    case "motion": {
      const boundingBox = on("bounding box")
      const timeCode = on("timecode")
      const frameMetrics = on("metrics")
      // Overlays (box/timecode/metrics) are only drawn frame-by-frame in OpenCV output mode;
      // FFmpeg mode fast-clips the raw stream with no drawing at all. Force OpenCV whenever
      // an overlay is requested so "draw bounding box" always actually draws one.
      const wantsOverlay = boundingBox || timeCode || frameMetrics
      return {
        input: files.map((f) => f.path),
        outputDir: dir ?? undefined,
        threshold: Number(values.th) || undefined,
        minEventLength: values.min ? `${values.min}s` : undefined,
        scanOnly: dry,
        outputMode: wantsOverlay || !values.mode?.startsWith("FFmpeg") ? "opencv" : "ffmpeg",
        boundingBox,
        timeCode,
        frameMetrics,
        frameSkip: Number(values.skip) || undefined,
        downscaleFactor: Number(values.down) || undefined,
      }
    }
    case "ocr":
      return { video: files[0]?.path, outputDir: dir, sampleRate: Number(values.rate), confidence: Number(values.conf) }
    case "faces":
      return { task: "index", video_path: files[0]?.path, output_dir: dir ?? undefined }
    case "objects":
      return { video: files[0]?.path, output: dir ? `${dir.replace(/[\\/]+$/, "")}\\objects-${Date.now()}.mp4` : undefined, model: "base" }
    case "upscale":
      return { image: files[0]?.path, outputDir: dir, scale: Number.parseInt(values.scale, 10), method: values.method?.startsWith("Upscayl") ? "upscayl" : "lanczos" }
  }
}

export default function ToolPage({ tool }: { tool: ToolKind }) {
  const t = tools[tool]
  const [files, setFiles] = useState<UploadedFile[]>([])
  const [uploading, setUploading] = useState(false)
  const [dry, setDry] = useState(false)
  const [checks, setChecks] = useState<Record<string, boolean>>(() => Object.fromEntries(t.checks.map((c) => [c, true])))
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries([...t.scan, ...t.perf].map((f) => [f.id, f.value])))
  const [done, setDone] = useState(false)
  const [dir] = useOutputDir()
  const { caseId = "" } = useParams()
  const clips = useRecoveredClips(caseId)
  const [clipKey, setClipKey] = useState("none")
  const clip = clips.find((c) => c.key === clipKey)
  const fileInput = useRef<HTMLInputElement>(null)
  const log = useTaskRun((success) => {
    setDone(success)
    toast[success ? "success" : "error"](success ? "Process complete" : "Process failed", {
      description: success ? t.done : "See the log for details.",
    })
  })
  const run = () => {
    if (!dir) {
      toast.error("The output folder is still loading. Try again in a moment.")
      return
    }
    setDone(false)
    const settings = buildSettings(tool, clip ? [] : files, values, checks, dry, dir)
    // Tie the run to this case (and to the recovered clip, if one was chosen) so Analytics and Correlation can use it.
    const tied = tool === "ocr" || tool === "upscale" ? { ...settings, caseId: Number(caseId) }
      : { ...settings, caseId: Number(caseId), ...(clip ? { clip: { imageId: clip.imageId, recordingId: clip.recordingId } } : {}) }
    log.start(tool, tied)
  }

  async function onPickFiles(fileList: FileList | null) {
    if (!fileList?.length) return
    setUploading(true)
    try {
      for (const file of Array.from(fileList)) {
        const res = await api.upload(file)
        setFiles((f) => tool === "motion" ? [...f, { name: res.filename, path: res.path }] : [{ name: res.filename, path: res.path }])
        setDone(false)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed")
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="space-y-10">
      <PageHeader eyebrow="Video analysis" title={t.title} description={t.description} />
      {t.note && (
        <Alert>
          <AlertDescription>{t.note}</AlertDescription>
        </Alert>
      )}
      <OutputDir />

      <Card>
        <CardHeader>
          <CardTitle>Input</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex flex-col items-center gap-4 rounded-lg border border-dashed py-10 text-center">
            <UploadSimpleIcon className="size-7 text-muted-foreground" />
            <p className="text-muted-foreground">{t.drop}</p>
            <input
              ref={fileInput}
              type="file"
              accept={tool === "ocr" ? "video/*,.avi,.mkv" : tool === "upscale" ? "image/*" : undefined}
              className="hidden"
              multiple={tool === "motion"}
              onChange={(e) => onPickFiles(e.target.files)}
            />
            <Button variant="outline" size="sm" disabled={uploading} onClick={() => fileInput.current?.click()}>
              {uploading ? "Uploading…" : "Browse files"}
            </Button>
          </div>
          {tool !== "ocr" && tool !== "upscale" && (
            <Field>
              <FieldLabel htmlFor="recovered-clip">Or analyse a recovered clip</FieldLabel>
              <Select value={clipKey} onValueChange={(v) => { setClipKey(v); setDone(false) }}>
                <SelectTrigger id="recovered-clip" className="w-full" aria-label="Recovered clip"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Use the uploaded file</SelectItem>
                  {clips.map((c) => <SelectItem key={c.key} value={c.key}>{c.label}</SelectItem>)}
                </SelectContent>
              </Select>
              <FieldDescription>
                {clips.length
                  ? "A recovered clip carries its channel and recorder time, so what is found can be placed on the timeline. An uploaded file has no known recording time."
                  : "No recovered clips yet. Recover a recording on the Recovery page and it will be listed here."}
              </FieldDescription>
            </Field>
          )}
          {files.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-caption text-muted-foreground tnum">Selected files ({files.length})</p>
                <Button variant="ghost" size="xs" onClick={() => setFiles([])}>
                  <XIcon /> Clear all
                </Button>
              </div>
              {files.map((f) => (
                <div key={f.path} className="flex items-center gap-3 rounded-md bg-muted px-4 py-2.5">
                  <FileVideoIcon className="size-4 text-muted-foreground" />
                  <span className="flex-1 truncate font-mono text-caption">{f.name}</span>
                  <Button variant="ghost" size="icon-xs" aria-label={`Remove ${f.name}`} onClick={() => setFiles((x) => x.filter((y) => y !== f))}>
                    <XIcon />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Settings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-8">
          <div className="grid gap-6 md:grid-cols-3">
            {t.scan.map((f) => (
              <FieldInput key={f.id} f={f} value={values[f.id]} onChange={(v) => setValues((x) => ({ ...x, [f.id]: v }))} />
            ))}
          </div>
          <div className="grid gap-8 md:grid-cols-2">
            {t.checks.length > 0 && <div className="space-y-3">
              <p className="text-caption font-medium text-muted-foreground">Overlays and options</p>
              {t.checks.map((c, i) => (
                <div key={c} className="flex items-center gap-2.5">
                  <Checkbox id={`c${i}`} checked={checks[c]} onCheckedChange={(v) => setChecks((x) => ({ ...x, [c]: v === true }))} />
                  <Label2 htmlFor={`c${i}`}>{c}</Label2>
                </div>
              ))}
            </div>}
            {t.perf.length > 0 && (
              <div className="space-y-4">
                <p className="text-caption font-medium text-muted-foreground">Performance</p>
                {t.perf.map((f) => (
                  <FieldInput key={f.id} f={f} value={values[f.id]} onChange={(v) => setValues((x) => ({ ...x, [f.id]: v }))} />
                ))}
              </div>
            )}
          </div>
          {t.roi && (
            <Field>
              <FieldLabel htmlFor="roi">Region of interest (space-separated points)</FieldLabel>
              <Textarea id="roi" placeholder={t.roi} className="font-mono text-caption" />
            </Field>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Run</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {log.running && <Progress value={log.progress} className="h-1.5" />}
          <div className="flex items-center gap-6">
            <Button size="lg" className="min-w-48" disabled={(!files.length && !clip) || log.running || uploading} onClick={run}>
              {log.running ? "Running…" : t.run}
            </Button>
            {t.dry && (
              <div className="flex items-center gap-2.5">
                <Checkbox id="dry" checked={dry} onCheckedChange={(v) => setDry(v === true)} />
                <Label2 htmlFor="dry">{t.dry}</Label2>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {t.out && (
        <Card>
          <CardHeader>
            <CardTitle>Output</CardTitle>
          </CardHeader>
          <CardContent>
            {done ? (
              tool === "ocr" || tool === "upscale" ? (
                log.outputPath ? (
                  <div className="space-y-3">
                    {tool === "upscale" ? (
                      <img src={api.outputFileUrl(log.outputPath)} alt="Upscaled image" className="mx-auto max-h-[70vh] w-auto max-w-full rounded-lg border object-contain" />
                    ) : (
                      <SurveillancePlayer src={api.outputFileUrl(log.outputPath)} title="Analysis output" />
                    )}
                    <DownloadOutput path={log.outputPath} />
                  </div>
                ) : <p className="text-muted-foreground">No output was produced. See the log for details.</p>
              ) : log.outputPath ? (
                <div className="space-y-3">
                  <SurveillancePlayer src={api.outputFileUrl(log.outputPath)} title="Analysis output" />
                  <div className="flex items-center justify-between">
                    <p className="font-mono text-caption text-muted-foreground">{log.outputPath.split(/[\\/]/).pop()}</p>
                    <DownloadOutput path={log.outputPath} />
                  </div>
                </div>
              ) : (
                <RealOutput dir={dir} />
              )
            ) : log.failure && !log.running ? (
              <div role="alert" className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 p-5">
                <p className="font-medium text-destructive">The run did not finish</p>
                <p className="text-body whitespace-pre-wrap">{log.failure}</p>
                <p className="text-caption text-muted-foreground">The full log is further down this page.</p>
              </div>
            ) : (
              <p className="rounded-lg border border-dashed py-14 text-center text-muted-foreground">
                {log.running ? "Processing…" : "The annotated video and its detections appear here after the run."}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <LogPanel lines={log.out} onClear={log.clear} empty="Choose an input and run the tool." />
    </div>
  )
}

function Label2(props: React.ComponentProps<"label">) {
  return <label className="text-body" {...props} />
}

/** Shows the real file the engine just wrote to the output directory (newest media file in it). */
function RealOutput({ dir }: { dir: string | null }) {
  const [file, setFile] = useState<{ name: string; path: string } | null | undefined>(undefined)
  useEffect(() => {
    if (!dir) return setFile(null)
    api
      .listOutputs(dir)
      .then((r) => setFile(r.files[0] ?? null))
      .catch(() => setFile(null))
  }, [dir])

  if (file === undefined) return <p className="text-muted-foreground">Looking for the output file…</p>
  if (!file)
    return (
      <p className="rounded-lg border border-dashed py-14 text-center text-muted-foreground">
        No output file found in the output directory. This task may not write a video/image (e.g. face indexing), or the output directory wasn't set.
      </p>
    )

  const url = api.outputFileUrl(file.path)
  const isImage = /\.(png|jpe?g)$/i.test(file.name)
  return (
    <div className="space-y-3">
      {isImage ? (
        // eslint-disable-next-line jsx-a11y/alt-text
        <img src={url} className="mx-auto max-h-[70vh] w-auto max-w-full rounded-lg border object-contain" />
      ) : (
        <SurveillancePlayer src={url} />
      )}
      <div className="flex items-center justify-between">
        <p className="font-mono text-caption text-muted-foreground">{file.name}</p>
        <DownloadOutput path={file.path} />
      </div>
    </div>
  )
}

/** Download link for a file already written to the output directory. */
function DownloadOutput({ path }: { path: string }) {
  return (
    <Button asChild variant="outline" size="sm">
      <a href={api.outputFileUrl(path)} download>
        <DownloadSimpleIcon /> Download
      </a>
    </Button>
  )
}
