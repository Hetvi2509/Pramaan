import { useEffect, useRef, useState } from "react"
import { CheckCircleIcon, CopyIcon, FolderOpenIcon, TrashIcon } from "@phosphor-icons/react"
import { useParams } from "react-router-dom"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { api, subscribeTask } from "@/lib/api"

// One output folder per case, shared by every tool. The server keeps it (in the data folder) and always has a
// working one, so the tools run on a new computer with nothing to set up.
type DirInfo = { dir: string; isDefault: boolean; problem: string | null; defaultDir: string }
const cache = new Map<string, DirInfo>()
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((l) => l())
const keep = (caseId: string, r: DirInfo) => { cache.set(caseId, { dir: r.dir, isDefault: r.isDefault, problem: r.problem, defaultDir: r.defaultDir }); notify() }

export function useOutputDir(): [string | null, (d: string | null) => Promise<void>, DirInfo | null] {
  const { caseId = "" } = useParams()
  const [, bump] = useState(0)
  useEffect(() => {
    const l = () => bump((n) => n + 1)
    listeners.add(l)
    if (caseId) api.outputDir(caseId).then((r) => keep(caseId, r)).catch(() => {})
    return () => void listeners.delete(l)
  }, [caseId])
  const info = cache.get(caseId) ?? null
  const set = async (d: string | null) => { keep(caseId, await api.setOutputDir(caseId, d)) }
  return [info?.dir ?? null, set, info]
}

type Picker = { showDirectoryPicker?: () => Promise<{ name: string }> }

/** "Global Output Directory": one folder shared by every tool in the case. */
export function OutputDir() {
  const [dir, setDir, info] = useOutputDir()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  async function browse() {
    // The desktop app opens the real Windows folder dialog and returns the full path.
    const host = (window as unknown as { pramaan?: { selectDirectory?: (start?: string) => Promise<string | null> } }).pramaan
    try {
      if (host?.selectDirectory) {
        const d = await host.selectDirectory(draft || dir || undefined)
        if (d) { setDraft(d); setError("") }
      } else if ((window as Picker).showDirectoryPicker) {
        const h = await (window as Picker).showDirectoryPicker!()
        setDraft((d) => (d.trim() ? d : h.name))
        toast("Folder chosen", { description: "A web browser only shares the folder's name. Check the full path before saving." })
      } else {
        toast("Type the folder path", { description: "Folder browsing needs the desktop app or a Chromium browser." })
      }
    } catch {
      /* picker dismissed */
    }
  }

  async function save(e: React.FormEvent, value: string | null = draft.trim()) {
    e.preventDefault()
    setBusy(true)
    setError("")
    try {
      await setDir(value)
      setOpen(false)
      toast.success(value ? "Output directory set" : "Using the default folder", { description: value ?? undefined })
    } catch (err) {
      setError(err instanceof Error ? err.message : "That folder cannot be used.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Card>
        <CardHeader className="grid-cols-[1fr_auto]">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2.5">
              <FolderOpenIcon className="size-5 text-muted-foreground" /> Global output directory
            </CardTitle>
            <CardDescription>Used by every tool in this case. Derived files are written here and hashed.</CardDescription>
          </div>
          <Button
            variant="outline"
            onClick={() => {
              setDraft(info && !info.isDefault ? info.dir : "")
              setError("")
              setOpen(true)
            }}
          >
            <FolderOpenIcon /> Change directory
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex h-11 items-center gap-2.5 rounded-md bg-muted px-4 font-mono text-caption">
            {dir ? (
              <>
                <CheckCircleIcon weight="fill" className="size-4 shrink-0 text-success" />
                <span className="truncate" title={dir}>{dir}</span>
                <span className="ml-auto shrink-0 font-sans text-muted-foreground">{info?.isDefault ? "Default" : "Chosen by you"}</span>
              </>
            ) : (
              <span className="text-muted-foreground">Looking for the output folder…</span>
            )}
          </div>
          {info?.problem && <p role="alert" className="text-caption text-warning">{info.problem}</p>}
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <form onSubmit={save} className="space-y-6">
            <DialogHeader className="space-y-2">
              <DialogTitle className="font-display text-heading font-normal">Output directory</DialogTitle>
              <DialogDescription>Results from the analysis tools are saved here. Choose a folder on this computer, not on the evidence disk.</DialogDescription>
            </DialogHeader>
            <Field>
              <FieldLabel htmlFor="outdir">Folder path</FieldLabel>
              <div className="flex gap-3">
                <Input id="outdir" autoFocus value={draft} onChange={(e) => { setDraft(e.target.value); setError("") }} placeholder={info?.defaultDir ?? String.raw`C:\Pramaan\Output`} className="font-mono text-caption" />
                <Button type="button" variant="outline" onClick={browse}>
                  Browse…
                </Button>
              </div>
              {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
            </Field>
            <DialogFooter className="gap-3 sm:justify-between sm:gap-3">
              <Button type="button" variant="ghost" disabled={busy || info?.isDefault} onClick={(e) => save(e, null)}>
                Use the default folder
              </Button>
              <div className="flex gap-3">
                <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={!draft.trim() || busy}>
                  {busy ? "Checking…" : "Save directory"}
                </Button>
              </div>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}

/** Picks the reason a run failed out of its log: an error the engine reported, else its last error output. */
function describeFailure(lines: unknown[]): string {
  const text = lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l)))
  for (const l of [...text].reverse()) {
    const m = l.match(/"(?:error|message)"\s*:\s*"((?:[^"\\]|\\.)+)"/)
    if (m && !/Process exited/.test(m[1]) && /_error|"success"\s*:\s*false/.test(l)) return m[1].replace(/\\n/g, "\n").slice(0, 400)
  }
  const problems = text.filter((l) => /\[(?:ERROR|PYTHON STDERR)\]/.test(l) && !/Progress:|it\/s\]|frames\/s/.test(l))
    .join("\n").replace(/\[(?:ERROR|PYTHON STDERR)\]\s*/g, "").split("\n")
    .map((l) => l.trim()).filter((l) => l && !/^\[\s*WARN/.test(l)) // library warnings are noise next to the real error
  if (problems.length) {
    const reason = problems.slice(-3).join("\n").slice(0, 400)
    return /VideoCapture|cap_images|could not open|cannot open/i.test(reason) ? `This file could not be opened as a video.\n${reason}` : reason
  }
  return "The tool stopped before it finished. The full log is below."
}

/** The face and object tools catch their own errors, print them as an event and still exit 0, so the exit code alone
 *  would call that a success. Any event the engine marks as an error means the run failed. */
function reportedError(items: unknown[]): string | null {
  for (const item of items) {
    if (!item || typeof item !== "object") continue
    const o = item as { type?: unknown; success?: unknown; error?: unknown }
    if ((/_error$/.test(String(o.type)) || o.success === false) && typeof o.error === "string" && o.error) return o.error.slice(0, 400)
  }
  return null
}

/** Runs a real backend task (motion/faces/objects/upscale via SSE, ocr synchronously) and streams its log. */
export function useTaskRun(onDone?: (success: boolean) => void) {
  const [out, setOut] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(0)
  const [outputPath, setOutputPath] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const seen = useRef<unknown[]>([])
  const unsubRef = useRef<(() => void) | null>(null)
  useEffect(() => () => unsubRef.current?.(), [])

  async function start(kind: "motion" | "ocr" | "faces" | "objects" | "upscale", settings: Record<string, unknown>) {
    if (running) return
    setOut([])
    setProgress(0)
    setOutputPath(null)
    setFailure(null)
    seen.current = []
    setRunning(true)
    try {
      if (kind === "ocr" && !settings.video) {
        setOut((o) => [...o, `Running OCR on ${settings.image}...`])
        const result = await api.runOcr(String(settings.image))
        setOut((o) => [...o, JSON.stringify(result)])
        setRunning(false)
        onDone?.(result.success)
        return
      }
      const { taskId } = kind === "upscale" ? await api.upscaleImage(settings) : await api.startTask(kind, settings)
      unsubRef.current = subscribeTask(taskId, {
        onLog: (line) => { seen.current.push(line); setOut((o) => [...o, line]) },
        onUpdate: (data) => {
          if (data?.type === "ocr_complete" && typeof data.output === "string") setOutputPath(data.output)
          if (data?.type === "forensics_result" && typeof data.data?.output === "string") setOutputPath(data.data.output)
          // Each tool reports the exact file it wrote, rather than the UI guessing from
          // whatever else happens to be newest in the shared output directory (see RealOutput).
          if ((data?.type === "object_detection_complete" || data?.type === "criminal_detection_complete") && typeof data.output_path === "string")
            setOutputPath(data.output_path)
          seen.current.push(data)
          setOut((o) => [...o, JSON.stringify(data)])
          if (typeof data?.progress === "number") setProgress(data.progress)
        },
        onComplete: (data) => {
          setOut((o) => [...o, `[PROCESS] Process exited with code ${data.code}`])
          const reported = data.success ? reportedError(seen.current) : null
          setProgress(100)
          setRunning(false)
          if (!data.success) setFailure(describeFailure(seen.current))
          else if (reported) setFailure(/open|read|decode|video/i.test(reported) ? `This file could not be opened as a video.\n${reported}` : reported)
          onDone?.(!!data.success && !reported)
        },
        onError: (msg) => {
          setOut((o) => [...o, `[ERROR] ${msg}`])
          setFailure(String(msg).slice(0, 400))
          setRunning(false)
          onDone?.(false)
        },
      })
    } catch (err) {
      setOut((o) => [...o, `[ERROR] ${err instanceof Error ? err.message : String(err)}`])
      setFailure(err instanceof Error ? err.message : String(err))
      setRunning(false)
      onDone?.(false)
    }
  }

  return { out, running, progress, outputPath, failure, start, clear: () => { setOut([]); setFailure(null) } }
}

export function LogPanel({ lines, onClear, empty = "Nothing has run yet." }: { lines: string[]; onClear?: () => void; empty?: string }) {
  const ref = useRef<HTMLPreElement>(null)
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight })
  }, [lines.length])
  return (
    <Card>
      <CardHeader className="grid-cols-[1fr_auto]">
        <CardTitle>Progress and output</CardTitle>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Copy logs"
            disabled={!lines.length}
            onClick={() => navigator.clipboard.writeText(lines.join("\n")).then(() => toast.success("Logs copied"))}
          >
            <CopyIcon />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Clear logs" disabled={!lines.length} onClick={onClear}>
            <TrashIcon />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <pre
          ref={ref}
          role="log"
          aria-live="polite"
          className="h-64 overflow-auto rounded-md bg-muted p-4 font-mono text-caption leading-relaxed whitespace-pre-wrap text-foreground/80"
        >
          {lines.length ? lines.join("\n") : <span className="text-muted-foreground">{empty}</span>}
        </pre>
      </CardContent>
    </Card>
  )
}
