import { useEffect, useRef, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { toast } from "sonner"
import { api, subscribeTask, type ApiImageFile } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Checkbox } from "@/components/ui/checkbox"
import { Progress } from "@/components/ui/progress"
import { PageHeader } from "./page-header"
import { LogPanel } from "./tool-bits"

type Mode = "parsing" | "viewer" | "device" | "explorer"
type Recording = { id: string; channel: number | null; start: string | null; end: string | null; offset: string; status: string }
type StoredData = Record<string, any>
const titles: Record<Mode, string> = { parsing: "Image parsing and hashing", viewer: "Data viewer", device: "Device identification", explorer: "Video explorer" }

function DataCard({ title, value }: { title: string; value: unknown }) {
  return <Card className="min-w-0"><CardHeader><CardTitle>{title}</CardTitle></CardHeader><CardContent>
    <pre tabIndex={0} className="max-h-96 overflow-auto rounded-md bg-muted p-4 font-mono text-caption whitespace-pre-wrap break-all">{JSON.stringify(value, null, 2)}</pre>
  </CardContent></Card>
}

/** Port of Niriksha's ViewDataPage and ForensicExplorerPanel to persisted HTTP evidence data. */
export function EvidenceWorkspace({ mode }: { mode: Mode }) {
  const { caseId = "" } = useParams()
  const [images, setImages] = useState<ApiImageFile[]>([])
  const [imageId, setImageId] = useState("")
  const [data, setData] = useState<StoredData>({})
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [logs, setLogs] = useState<string[]>([])
  const [error, setError] = useState("")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [preview, setPreview] = useState<string | null>(null)
  const stop = useRef<(() => void) | null>(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; stop.current?.() } }, [])

  useEffect(() => {
    let active = true
    setImages([]); setImageId(""); setData({}); setError("")
    api.listImages(caseId).then(r => { if (active) {
      setImages(r.data)
      const saved = sessionStorage.getItem(`pramaan.evidence.${caseId}`)
      setImageId(String(r.data.find(i => String(i.id) === saved)?.id ?? r.data[0]?.id ?? ""))
    } })
      .catch(e => { if (active) setError(e.message) })
    return () => { active = false }
  }, [caseId])

  useEffect(() => {
    let active = true
    setData({}); setSelected(new Set()); setPreview(null); setLogs([]); setError("")
    if (!imageId) return
    setLoading(true)
    api.getForensics(imageId).then(r => { if (active) setData(r.data) })
      .catch(e => { if (active) setError(e.message) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [imageId])

  async function reload() {
    const result = await api.getForensics(imageId)
    if (mounted.current) setData(result.data)
  }

  async function task(action: "hash" | "identify" | "parse" | "extract", recordingId?: string) {
    const { taskId } = await api.evidenceTask(imageId, action, recordingId)
    if (!mounted.current) return
    await new Promise<void>((resolve, reject) => {
      stop.current = subscribeTask(taskId, {
        onLog: line => setLogs(l => [...l, typeof line === "string" ? line : JSON.stringify(line)]),
        onUpdate: event => {
          if (event.type === "progress") setProgress(event.progress)
          if (event.type === "forensics_error") setLogs(l => [...l, event.message])
          if (event.type === "forensics_result") {
            setLogs(l => [...l, `${action}: engine processing finished; saving results…`])
            if (event.data.output) setPreview(event.data.output)
          }
        },
        onComplete: event => event.success ? resolve() : reject(new Error("Processing failed. See the log for details.")),
        onError: message => reject(new Error(message)),
      })
    })
    await reload()
  }

  async function run(action: "hash" | "identify" | "parse" | "extract", ids: string[] = []) {
    if (!imageId || busy) return
    setBusy(true); setError(""); setProgress(0); setLogs([]); setPreview(null)
    try {
      if (action === "extract") {
        for (const id of ids) { if (!mounted.current) break; await task(action, id) }
      } else await task(action)
      if (mounted.current) { setProgress(100); toast.success(`${action === "hash" ? "Hash verification" : action} complete`) }
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)) }
    finally { if (mounted.current) setBusy(false) }
  }

  const rows: Recording[] = data.recordings ?? []
  const playable = rows.filter(r => r.status !== "No Video/Recording")
  const identification = data.identification
  return <div className="space-y-10">
    <PageHeader eyebrow="DVR forensics" title={titles[mode]} description="Results belong to the selected evidence item. Original evidence is opened read-only; derived files are saved separately." />
    <Card><CardHeader><CardTitle>Evidence</CardTitle></CardHeader><CardContent className="space-y-4">
      {images.length ? <Select value={imageId} onValueChange={id => { sessionStorage.setItem(`pramaan.evidence.${caseId}`, id); setImageId(id) }} disabled={busy}>
        <SelectTrigger className="w-full max-w-xl" aria-label="Evidence image"><SelectValue /></SelectTrigger>
        <SelectContent>{images.map(i => <SelectItem key={i.id} value={String(i.id)}>{i.filename}</SelectItem>)}</SelectContent>
      </Select> : <p>No evidence uploaded. <Link className="underline" to={`/cases/${caseId}/evidence`}>Add evidence</Link> to begin.</p>}
      <div className="flex flex-wrap gap-3">
        <Button disabled={!imageId || busy || loading} onClick={() => run("hash")}>Calculate MD5 + SHA-256 / verify</Button>
        <Button variant="outline" disabled={!imageId || busy || loading} onClick={() => run("identify")}>Identify format</Button>
        <Button variant="outline" disabled={!imageId || busy || loading} onClick={() => run("parse")}>Parse evidence</Button>
        <Button variant="ghost" disabled={!imageId || busy} onClick={() => reload().catch(e => setError(e.message))}>Refresh saved results</Button>
      </div>
      {busy && <Progress value={progress} />}
      {loading && <p>Loading saved results…</p>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </CardContent></Card>

    {(mode === "parsing" || mode === "device") && <>
      {identification && <DataCard title="Format identification and signature evidence" value={identification} />}
      {mode === "parsing" && <div className="grid gap-6 lg:grid-cols-2">
        {data.intake_hashes && <DataCard title="Intake hashes — uploaded file bytes" value={data.intake_hashes} />}
        {data.media_hashes && <DataCard title="Evidence hashes" value={data.media_hashes} />}
        {data.integrity && <DataCard title={data.integrity.matches === true ? "Integrity matches intake" : data.integrity.matches === false ? "Integrity mismatch" : "No intake hash available"} value={data.integrity} />}
      </div>}
      {data.parsed_bundle && <p>Saved {rows.length} recording entries. <Link className="underline" to={`/cases/${caseId}/viewer`}>Inspect parsed data</Link> or <Link className="underline" to={`/cases/${caseId}/explorer`}>open video explorer</Link>.</p>}
      {!identification && !busy && <p className="text-muted-foreground">Run identification or parsing to inspect this evidence. Supported adapters: Hikvision disks, DHAV streams, and standard playable video containers. Other proprietary formats are reported as unsupported.</p>}
    </>}

    {mode === "viewer" && <div className="grid gap-6 xl:grid-cols-2">
      {["master_sector", "hikbtree", "system_logs", "media", "identification", "recordings"].filter(key => data[key] !== undefined).map(key => <DataCard key={key} title={key.replaceAll("_", " ")} value={data[key]} />)}
      {!data.parsed_bundle && <p className="text-muted-foreground">Parse the selected evidence to view its raw structures, field addresses, logs, and recordings.</p>}
    </div>}

    {mode === "explorer" && <Card><CardHeader><CardTitle>Recordings ({rows.length})</CardTitle></CardHeader><CardContent className="space-y-5">
      <div className="flex gap-3"><Button disabled={busy || !selected.size} onClick={() => run("extract", [...selected])}>Extract selected ({selected.size})</Button>
        <Button variant="outline" disabled={busy || !playable.length} onClick={() => run("extract", playable.map(r => r.id))}>Extract all</Button></div>
      <div className="max-h-96 overflow-auto"><Table><TableHeader><TableRow>
        <TableHead><Checkbox aria-label="Select all recordings" disabled={busy || !playable.length} checked={!!playable.length && playable.every(r => selected.has(r.id))} onCheckedChange={v => setSelected(v === true ? new Set(playable.map(r => r.id)) : new Set())} /></TableHead>
        <TableHead>Channel</TableHead><TableHead>Start (recorder clock)</TableHead><TableHead>End</TableHead><TableHead>Offset</TableHead><TableHead>Status</TableHead><TableHead>Video</TableHead>
      </TableRow></TableHeader><TableBody>{rows.map(r => <TableRow key={r.id}>
        <TableCell><Checkbox aria-label={`Select recording ${r.id}`} checked={selected.has(r.id)} disabled={busy || r.status === "No Video/Recording"} onCheckedChange={v => setSelected(s => { const next = new Set(s); if (v === true) next.add(r.id); else next.delete(r.id); return next })} /></TableCell>
        <TableCell>{r.channel ?? "Unknown"}</TableCell><TableCell>{r.start ?? "Not available"}</TableCell><TableCell>{r.end ?? "Not available"}</TableCell><TableCell className="font-mono">{r.offset}</TableCell><TableCell>{r.status}</TableCell>
        <TableCell><Button size="sm" variant="outline" disabled={busy || r.status === "No Video/Recording"} onClick={() => data[`extraction_${r.id}`]?.output ? setPreview(data[`extraction_${r.id}`].output) : run("extract", [r.id])}>View video</Button></TableCell>
      </TableRow>)}</TableBody></Table></div>
      {!rows.length && <p className="text-muted-foreground">No recordings saved. Parse evidence first.</p>}
      {preview && <div className="space-y-3"><video src={api.outputFileUrl(preview)} controls className="w-full rounded-lg border" /><a className="underline" href={api.outputFileUrl(preview)} download>Download viewing copy</a></div>}
    </CardContent></Card>}
    {(data.warnings ?? []).map((warning: string) => <p key={warning} className="text-caption text-muted-foreground">{warning}</p>)}
    <LogPanel lines={logs} onClear={() => setLogs([])} empty="Run an evidence task to see its progress." />
  </div>
}
