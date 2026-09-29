import { useEffect, useRef, useState } from "react"
import { CheckCircleIcon, CopyIcon, FolderOpenIcon, TrashIcon } from "@phosphor-icons/react"
import { useParams } from "react-router-dom"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { cases, outputDir } from "@/lib/mock"
import { api, subscribeTask } from "@/lib/api"

// One output folder per case, shared by every tool and remembered between sessions.
const KEY = "pramaan.outdir"
const listeners = new Set<() => void>()
const read = (): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}")
  } catch {
    return {}
  }
}
export function useOutputDir(): [string | null, (d: string) => void] {
  const { caseId = "" } = useParams()
  const [, bump] = useState(0)
  useEffect(() => {
    const l = () => bump((n) => n + 1)
    listeners.add(l)
    return () => void listeners.delete(l)
  }, [])
  const demo = !!cases.find((c) => c.id === caseId && !c.fresh) // only the sample cases pretend to have a directory
  const dir = read()[caseId] ?? (demo ? outputDir : null)
  const set = (d: string) => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...read(), [caseId]: d }))
    } catch {
      /* storage blocked: the choice lasts until reload */
    }
    listeners.forEach((l) => l())
  }
  return [dir, set]
}

type Picker = { showDirectoryPicker?: () => Promise<{ name: string }> }

/** "Global Output Directory": one folder shared by every tool in the case. */
export function OutputDir() {
  const [dir, setDir] = useOutputDir()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState("")

  async function browse() {
    // Browsers only reveal the folder's name, never its full path; the desktop shell can return the full path.
    const host = (window as unknown as { pramaan?: { selectDirectory?: () => Promise<string | null> } }).pramaan
    try {
      if (host?.selectDirectory) {
        const d = await host.selectDirectory()
        if (d) setDraft(d)
      } else if ((window as Picker).showDirectoryPicker) {
        const h = await (window as Picker).showDirectoryPicker!()
        setDraft((d) => (d.trim() ? d : h.name))
        toast("Folder chosen", { description: "The browser only shares its name. Check the full path before saving." })
      } else {
        toast("Type the folder path", { description: "Folder browsing needs the desktop app or a Chromium browser." })
      }
    } catch {
      /* picker dismissed */
    }
  }

  function save(e: React.FormEvent) {
    e.preventDefault()
    const d = draft.trim()
    if (!d) return
    setDir(d)
    setOpen(false)
    toast.success("Output directory set", { description: d })
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
            variant={dir ? "outline" : "default"}
            onClick={() => {
              setDraft(dir ?? "")
              setOpen(true)
            }}
          >
            <FolderOpenIcon /> {dir ? "Change directory" : "Set directory"}
          </Button>
        </CardHeader>
        <CardContent>
          <div className="flex h-11 items-center gap-2.5 rounded-md bg-muted px-4 font-mono text-caption">
            {dir ? (
              <>
                <CheckCircleIcon weight="fill" className="size-4 shrink-0 text-success" />
                <span className="truncate">{dir}</span>
              </>
            ) : (
              <span className="text-muted-foreground">No output directory set</span>
            )}
          </div>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <form onSubmit={save} className="space-y-6">
            <DialogHeader className="space-y-2">
              <DialogTitle className="font-display text-heading font-normal">Output directory</DialogTitle>
              <DialogDescription>Extracted video, parsed data and reports are saved here. Choose a folder on the examination workstation, not the evidence disk.</DialogDescription>
            </DialogHeader>
            <Field>
              <FieldLabel htmlFor="outdir">Folder path</FieldLabel>
              <div className="flex gap-3">
                <Input id="outdir" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={String.raw`D:\Cases\PRM-2026-0142\Outputs`} className="font-mono text-caption" />
                <Button type="button" variant="outline" onClick={browse}>
                  Browse…
                </Button>
              </div>
            </Field>
            <DialogFooter className="gap-3 sm:gap-3">
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!draft.trim()}>
                Save directory
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}

/** Runs a real backend task (motion/faces/objects/upscale via SSE, ocr synchronously) and streams its log. */
export function useTaskRun(onDone?: (success: boolean) => void) {
  const [out, setOut] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(0)
  const [outputPath, setOutputPath] = useState<string | null>(null)
  const unsubRef = useRef<(() => void) | null>(null)
  useEffect(() => () => unsubRef.current?.(), [])

  async function start(kind: "motion" | "ocr" | "faces" | "objects" | "upscale", settings: Record<string, unknown>) {
    if (running) return
    setOut([])
    setProgress(0)
    setOutputPath(null)
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
        onLog: (line) => setOut((o) => [...o, line]),
        onUpdate: (data) => {
          if (data?.type === "ocr_complete" && typeof data.output === "string") setOutputPath(data.output)
          if (data?.type === "forensics_result" && typeof data.data?.output === "string") setOutputPath(data.data.output)
          // Each tool reports the exact file it wrote, rather than the UI guessing from
          // whatever else happens to be newest in the shared output directory (see RealOutput).
          if ((data?.type === "object_detection_complete" || data?.type === "criminal_detection_complete") && typeof data.output_path === "string")
            setOutputPath(data.output_path)
          setOut((o) => [...o, JSON.stringify(data)])
          if (typeof data?.progress === "number") setProgress(data.progress)
        },
        onComplete: (data) => {
          setOut((o) => [...o, `[PROCESS] Process exited with code ${data.code}`])
          setProgress(100)
          setRunning(false)
          onDone?.(!!data.success)
        },
        onError: (msg) => {
          setOut((o) => [...o, `[ERROR] ${msg}`])
          setRunning(false)
          onDone?.(false)
        },
      })
    } catch (err) {
      setOut((o) => [...o, `[ERROR] ${err instanceof Error ? err.message : String(err)}`])
      setRunning(false)
      onDone?.(false)
    }
  }

  return { out, running, progress, outputPath, start, clear: () => setOut([]) }
}

/** Streams `lines` into a log panel; call `start()` to run. */
export function useLogStream(lines: string[], onDone?: () => void) {
  const [out, setOut] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const timer = useRef<ReturnType<typeof setInterval>>(undefined)
  useEffect(() => () => clearInterval(timer.current), [])

  function start() {
    if (running) return
    setOut([])
    setRunning(true)
    let i = 0
    timer.current = setInterval(() => {
      setOut((o) => [...o, lines[i]])
      if (++i >= lines.length) {
        clearInterval(timer.current)
        setRunning(false)
        onDone?.()
      }
    }, 260)
  }
  return { out, running, start, clear: () => setOut([]), progress: lines.length ? (out.length / lines.length) * 100 : 0 }
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
