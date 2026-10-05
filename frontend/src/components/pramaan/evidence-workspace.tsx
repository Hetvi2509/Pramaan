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
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PageHeader } from "./page-header"
import { FootageDot } from "./status"
import { LogPanel } from "./tool-bits"
import { SurveillancePlayer } from "./video-player"
import { Input } from "@/components/ui/input"
import { DEFAULT_TIME, TIMEZONES, toUtc, tzLabel, type TimeSettings } from "@/lib/time"

type Mode = "parsing" | "viewer" | "device" | "explorer" | "recovery"
type State = "live" | "deleted" | "unknown" | "empty"
type Recording = { id: string; channel: number | null; start: string | null; end: string | null; offset: string; status: string; state?: State; path?: string }
type Gate = { result: "passed" | "excluded"; reason: string | null; frames: number; decoder_errors: number }
type StoredData = Record<string, any>
const titles: Record<Mode, string> = { parsing: "Image parsing and hashing", viewer: "Data viewer", device: "Device identification", explorer: "Video explorer", recovery: "Recovered clips" }
const stateLabel: Record<State, string> = { live: "Live", deleted: "Deleted", unknown: "Allocation unknown", empty: "No video" }
const recoveryTabs = [["all", "All"], ["live", "Live"], ["deleted", "Deleted"], ["unknown", "Unknown"], ["excluded", "Excluded"]] as const

type Vendor = { brand: string | null; confidence: string; candidates: string[]; evidence: string[]; note: string; supported_brands: string[] }

const brandLogos: Record<string, string> = {
  "Dahua Technology": "dahua.svg", "CP Plus": "cpplus.png", "Honeywell Security": "honeywell.svg", "TP-Link": "tplink.svg",
  Godrej: "godrej.svg", Uniview: "uniview.png", Hikvision: "hikvision.svg", Matrix: "matrix.png",
}

/** A brand's logo, shown only for a brand we have evidence for. Logos are the owners' trademarks, used to identify the brand. */
function BrandLogo({ brand }: { brand: string }) {
  const file = brandLogos[brand]
  return file ? <img src={`/brands/${file}`} alt={`${brand} logo`} className="h-10 w-auto max-w-44 object-contain" onError={e => { e.currentTarget.style.display = "none" }} /> : null
}

/** Who made the recorder the footage came from, and the evidence for it. A brand is never named without evidence. */
function VendorCard({ vendor }: { vendor: Vendor }) {
  const headline = vendor.brand ?? (vendor.candidates.length ? vendor.candidates.join(" or ") : "Brand not determined")
  return <Card><CardHeader><CardTitle>Source of the footage</CardTitle></CardHeader><CardContent className="space-y-5">
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
      {(vendor.brand ? [vendor.brand] : vendor.candidates).map(b => <BrandLogo key={b} brand={b} />)}
      <p className="font-display text-title">{headline}</p><Badge variant={vendor.brand ? "default" : "neutral"}>{vendor.confidence}</Badge>
    </div>
    <ul aria-label="Brands checked" className="flex flex-wrap gap-2">
      {vendor.supported_brands.map(b => <li key={b}><Badge variant={b === vendor.brand ? "default" : vendor.candidates.includes(b) ? "primary" : "outline"}>{b}</Badge></li>)}
    </ul>
    {vendor.evidence.length > 0 && <ul className="space-y-1 text-caption text-muted-foreground">{vendor.evidence.map(e => <li key={e}>{e}</li>)}</ul>}
    <p className="text-caption text-muted-foreground">{vendor.note}</p>
  </CardContent></Card>
}

type IField = { role: string; offset: number; width: number; endian: string; score: number; evidence: string; value?: string; encoding?: string; algorithm?: string; alternatives?: string[] }
type Induction = {
  found: boolean; reason?: string; limits: string; ksy?: string
  payloads: { access_units: number; key_frames: number; codecs: string[]; resolutions: string[] }
  split?: { induced_from: number; held_out: number; held_out_region: string }
  schema?: { mode: string; anchor: string | null; fixed_header_bytes: number | null; extension_bytes: number; fields: IField[]; undecoded_bytes: number[] }
  verification?: { records: number; coverage: number; consistency: number; accepted: boolean }
  fallback?: { method: string; groups: { sps: string; access_units: number }[] }
}
const roleLabels: Record<string, string> = {
  constant: "Magic / constant", length: "Length", ext_length: "Extension length", timestamp: "Timestamp", relative_clock: "Tick counter",
  counter: "Counter", resolution: "Resolution", frame_type: "Key-frame flag", channel: "Channel", checksum: "Checksum",
}
const pct = (x: number) => `${Math.round(x * 100)}%`

/** What blind induction learned about an unknown recorder's record header from the video alone, and whether it held up on unseen data. */
function InductionCard({ result }: { result: Induction }) {
  const v = result.verification
  return <Card><CardHeader><CardTitle>Layout learned from the video</CardTitle></CardHeader><CardContent className="space-y-5">
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <Badge variant={result.found ? "default" : "neutral"}>{result.found ? "Verified on a held-out region" : "Not verified"}</Badge>
      <p className="text-caption text-muted-foreground tnum">
        {result.payloads.access_units} video access units ({result.payloads.codecs.join(", ") || "none"}, {result.payloads.resolutions.join(", ") || "no resolution"})
        {result.split && ` · learned from ${result.split.induced_from}, checked on ${result.split.held_out} from ${result.split.held_out_region}`}
      </p>
    </div>
    {result.reason && <p className="text-muted-foreground">{result.reason}</p>}
    {v && <p className="tnum">On the held-out records the header was located in {pct(v.coverage)} and every learned rule held in {pct(v.consistency)}. Both must reach 95%.</p>}
    {result.schema && <div className="overflow-x-auto rounded-lg border"><Table><TableHeader><TableRow className="hover:bg-transparent">
      <TableHead className="pl-4">Role</TableHead><TableHead>Offset</TableHead><TableHead>Width</TableHead><TableHead className="text-right">Score</TableHead><TableHead className="pr-4">Why</TableHead>
    </TableRow></TableHeader><TableBody>{result.schema.fields.map(f => <TableRow key={`${f.role}-${f.offset}`}>
      <TableCell className="pl-4 font-medium">{roleLabels[f.role] ?? f.role}</TableCell>
      <TableCell className="font-mono tnum">{f.offset}</TableCell>
      <TableCell className="tnum">{f.width} byte{f.width > 1 ? "s" : ""}{f.endian !== "-" && f.width > 1 ? `, ${f.endian === "be" ? "big" : "little"}-endian` : ""}</TableCell>
      <TableCell className="text-right tnum">{f.score.toFixed(2)}</TableCell>
      <TableCell className="max-w-md pr-4 whitespace-normal text-muted-foreground">{f.value ? <span className="font-mono">{f.value} </span> : null}{f.evidence}{f.algorithm ? ` (${f.algorithm})` : ""}</TableCell>
    </TableRow>)}</TableBody></Table></div>}
    {result.schema && <p className="text-caption text-muted-foreground">
      Offsets count from {result.schema.mode === "anchored" ? "the first byte of the repeated marker found before each record" : "the start of each video payload, backwards"}.
      {result.schema.extension_bytes ? ` Headers vary by up to ${result.schema.extension_bytes} bytes.` : ""}
      {result.schema.undecoded_bytes.length ? ` Header bytes with no learned role: ${result.schema.undecoded_bytes.join(", ")}.` : ""}
    </p>}
    {result.fallback && <p className="text-caption text-muted-foreground">Fallback: {result.fallback.method}: {result.fallback.groups.map(g => `${g.sps} (${g.access_units})`).join(", ")}.</p>}
    {result.ksy && <pre tabIndex={0} aria-label="Kaitai Struct description" className="max-h-72 overflow-auto rounded-md bg-muted p-4 font-mono text-caption whitespace-pre-wrap">{result.ksy}</pre>}
    <p className="text-caption text-muted-foreground">{result.limits} Learned from this evidence alone: confirm against the recorder's own export before relying on it.</p>
  </CardContent></Card>
}

function StateDot({ state }: { state: State }) {
  if (state === "live" || state === "deleted") return <FootageDot status={state} />
  return <span aria-hidden className="inline-block size-2.5 rounded-full border border-muted-foreground/60" />
}

function KnowledgeCard({ match }: { match: any }) {
  const tone = match.status === "VALIDATED" ? "success" : match.status === "CANDIDATE" ? "warning" : "neutral"
  const best = match.best_match
  return <Card>
    <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
      <div className="space-y-1">
        <CardTitle>Knowledge base</CardTitle>
        <p className="text-caption text-muted-foreground">
          {match.matched_known_layout
            ? "This storage layout matches one already in the knowledge base."
            : "This storage layout is new to the knowledge base and has been recorded."}
        </p>
      </div>
      <Badge variant={tone}>{match.status}</Badge>
    </CardHeader>
    <CardContent className="space-y-3">
      <p>#{match.fingerprint_id} {match.label} <span className="text-muted-foreground">· seen {match.observations} time{match.observations === 1 ? "" : "s"} · confidence {match.confidence.toFixed(2)}</span></p>
      {best && <p className="text-caption">
        Matched record #{best.id} — <span className="tnum">{(best.similarity * 100).toFixed(0)}% of traits agree</span>
        {best.shared.length ? ` (${best.shared.length} agreeing, ${best.only_in_this_evidence.length + best.only_in_stored_record.length} differing)` : ""}
      </p>}
      {!!match.candidate_profiles?.length && <div className="space-y-1">
        <p className="text-caption text-muted-foreground">Similar records worth checking by hand</p>
        {match.candidate_profiles.map((c: any) => <p key={c.id} className="text-caption">
          #{c.id} {c.label} — <span className="tnum">{(c.similarity * 100).toFixed(0)}%</span>
          {c.requires_validation && <span className="text-muted-foreground"> · needs an analyst's decision</span>}
        </p>)}
      </div>}
      <p className="text-caption text-muted-foreground">{match.note}</p>
      <Link className="text-caption underline" to="/knowledge">Open the knowledge base to confirm or reject</Link>
    </CardContent>
  </Card>
}

function TimeCard({ settings, onSave, disabled }: { settings: TimeSettings; onSave: (s: TimeSettings) => void; disabled: boolean }) {
  const [tz, setTz] = useState(String(settings.tzMinutes))
  const [drift, setDrift] = useState(String(settings.driftSeconds))
  useEffect(() => { setTz(String(settings.tzMinutes)); setDrift(String(settings.driftSeconds)) }, [settings.tzMinutes, settings.driftSeconds])
  const driftValue = Number(drift), valid = drift.trim() !== "" && Number.isFinite(driftValue)
  return <div className="flex flex-wrap items-end gap-4 rounded-lg border bg-card p-4">
    <div className="space-y-1.5"><label className="text-caption text-muted-foreground" htmlFor="tz">Recorder time zone</label>
      <Select value={tz} onValueChange={setTz}><SelectTrigger id="tz" className="w-44" aria-label="Recorder time zone"><SelectValue /></SelectTrigger>
        <SelectContent>{TIMEZONES.map(m => <SelectItem key={m} value={String(m)}>{tzLabel(m)}{m === 330 ? " (India)" : ""}</SelectItem>)}</SelectContent></Select></div>
    <div className="space-y-1.5"><label className="text-caption text-muted-foreground" htmlFor="drift">Recorder clock drift (seconds fast)</label>
      <Input id="drift" type="number" step="any" className="w-44" value={drift} onChange={e => setDrift(e.target.value)} /></div>
    <Button variant="outline" disabled={disabled || !valid} onClick={() => onSave({ tzMinutes: Number(tz), driftSeconds: driftValue })}>Apply and log</Button>
    <p className="max-w-md text-caption text-muted-foreground">The recorder time is never changed. UTC is worked out as recorder time minus drift minus the time-zone offset. Use a negative drift if the recorder runs slow.</p>
  </div>
}

function DataCard({ title, value, glance, tall }: { title: string; value: unknown; glance?: [string, unknown][] | null; tall?: boolean }) {
  return <Card className="min-w-0"><CardHeader><CardTitle>{title}</CardTitle></CardHeader><CardContent className="space-y-4">
    {glance && <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-caption">
      {glance.filter(([, v]) => v != null && v !== "").map(([k, v]) => <div key={k} className="contents"><dt className="text-muted-foreground">{k}</dt><dd className="tnum break-all">{String(v)}</dd></div>)}</dl>}
    <pre tabIndex={0} className={`${tall ? "max-h-[32rem]" : "max-h-96"} overflow-auto rounded-md bg-muted p-4 font-mono text-caption whitespace-pre-wrap break-all`}>{JSON.stringify(value, null, 2)}</pre>
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
  const [tab, setTab] = useState("all")
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

  async function task(action: "hash" | "identify" | "parse" | "extract" | "induce", recordingId?: string) {
    const { taskId } = await api.evidenceTask(imageId, action, recordingId)
    if (!mounted.current) return
    let engineError = ""
    await new Promise<void>((resolve, reject) => {
      stop.current = subscribeTask(taskId, {
        onLog: line => setLogs(l => [...l, typeof line === "string" ? line : JSON.stringify(line)]),
        onUpdate: event => {
          if (event.type === "progress") setProgress(event.progress)
          if (event.type === "forensics_error") { engineError = event.message; setLogs(l => [...l, event.message]) }
          if (event.type === "forensics_result") {
            setLogs(l => [...l, `${action}: engine processing finished; saving results…`])
            if (event.data.output) setPreview(event.data.output)
          }
        },
        onComplete: event => event.success ? resolve() : reject(new Error(engineError || "Processing failed. See the log for details.")),
        onError: message => reject(new Error(message)),
      })
    })
    await reload()
  }

  async function run(action: "hash" | "identify" | "parse" | "extract" | "induce", ids: string[] = []) {
    if (!imageId || busy) return
    setBusy(true); setError(""); setProgress(0); setLogs([]); setPreview(null)
    try {
      if (action === "extract") {
        for (const id of ids) { if (!mounted.current) break; await task(action, id) }
      } else await task(action)
      if (mounted.current) { setProgress(100); toast.success(`${action === "hash" ? "Hash verification" : action === "induce" ? "Layout learning" : action} complete`) }
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)) }
    finally { if (mounted.current) setBusy(false) }
  }

  const rows: Recording[] = data.recordings ?? []
  const timeSettings: TimeSettings = data.time_settings ?? DEFAULT_TIME
  const utc = (raw: string | null) => toUtc(raw, timeSettings)
  const saveTime = async (next: TimeSettings) => {
    try { await api.saveForensics(imageId, "time_settings", next); setData(d => ({ ...d, time_settings: next })); toast.success("Time settings saved and logged") }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  const playable = rows.filter(r => r.status !== "No Video/Recording")
  const identification = data.identification
  const bundle: StoredData = data.parsed_bundle ?? {}
  const vendor: Vendor | undefined = bundle.vendor ?? identification?.vendor
  const gateOf = (r: Recording): Gate | undefined => data[`extraction_${r.id}`]?.gate
  const stateOf = (r: Recording): State => r.state ?? (r.status === "No Video/Recording" ? "empty" : "unknown")
  const inTab = (r: Recording, t: string) => t === "all" || (t === "excluded" ? gateOf(r)?.result === "excluded" : stateOf(r) === t)
  const pending = playable.filter(r => !data[`extraction_${r.id}`])
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
        {(mode === "parsing" || mode === "device") && <Button variant="outline" disabled={!imageId || busy || loading} onClick={() => run("induce")}>Learn layout (unknown format)</Button>}
        <Button variant="ghost" disabled={!imageId || busy} onClick={() => reload().catch(e => setError(e.message))}>Refresh saved results</Button>
      </div>
      {busy && <Progress value={progress} />}
      {loading && <p>Loading saved results…</p>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </CardContent></Card>

    {(mode === "parsing" || mode === "device" || mode === "recovery") && vendor && <VendorCard vendor={vendor} />}

    {(mode === "parsing" || mode === "device") && data.induction && <InductionCard result={data.induction} />}

    {(mode === "parsing" || mode === "device") && <>
      {identification && <DataCard title="Format identification and signature evidence" value={identification} />}
      {mode === "parsing" && <div className="grid gap-6 lg:grid-cols-2">
        {data.intake_hashes && <DataCard title="Intake hashes — uploaded file bytes" value={data.intake_hashes} />}
        {data.media_hashes && <DataCard title="Evidence hashes" value={data.media_hashes} />}
        {data.integrity && <DataCard title={data.integrity.matches === true ? "Integrity matches intake" : data.integrity.matches === false ? "Integrity mismatch" : "No intake hash available"} value={data.integrity} />}
      </div>}
      {data.knowledge_match && <KnowledgeCard match={data.knowledge_match} />}
      {data.parsed_bundle && <p>Saved {rows.length} recording entries. <Link className="underline" to={`/cases/${caseId}/viewer`}>Inspect parsed data</Link> or <Link className="underline" to={`/cases/${caseId}/explorer`}>open video explorer</Link>.</p>}
      {!identification && !busy && <p className="text-muted-foreground">Run identification or parsing to inspect this evidence. Hikvision disks, DHAV streams, FAT/NTFS/ext disks holding video files and standard video containers are parsed directly. Any other disk is carved for DHAV, MPEG-PS, H.264 and H.265 video.</p>}
    </>}

    {mode === "viewer" && <div className="space-y-6">
      {(bundle.master_sector || bundle.hikbtree || bundle.system_logs) && <div className="grid gap-6 lg:grid-cols-3">
        <DataCard title="Master Sector" value={bundle.master_sector} tall
          glance={bundle.master_sector && [["Disk capacity", `${bundle.master_sector.master_sector?.disk_capacity?.value?.toLocaleString()} bytes`], ["System logs at", bundle.master_sector.master_sector?.system_logs_offset?.value_hex], ["Data block size", bundle.master_sector.master_sector?.data_block_size?.value?.toLocaleString()]]} />
        <DataCard title="HIKBTREE" value={bundle.hikbtree} tall
          glance={bundle.hikbtree && [["Created", bundle.hikbtree.header?.created_time?.value_readable], ["Footer at", bundle.hikbtree.header?.footer_address?.value_readable], ["Pages", Object.keys(bundle.hikbtree.pages ?? {}).length]]} />
        <DataCard title="System Logs" value={bundle.system_logs} tall
          glance={bundle.system_logs && [["Log entries", bundle.system_logs.system_logs?.length ?? 0], ["Log area at", bundle.system_logs.log_header_info?.start_address_hex], ["Latest", bundle.system_logs.system_logs?.at(-1)?.timestamp_readable]]} />
      </div>}
      {data.parsed_bundle && !bundle.master_sector && <p className="rounded-lg border bg-card p-4 text-muted-foreground">Master Sector, HIKBTREE and System Logs are Hikvision structures, and this evidence is not a Hikvision disk, so none were found. The structures its parser did find are listed below.</p>}
      <div className="grid gap-6 xl:grid-cols-2">
        {Object.entries(bundle).filter(([key]) => !["warnings", "master_sector", "hikbtree", "system_logs"].includes(key)).sort(([a], [b]) => Number(a === "recordings") - Number(b === "recordings"))
          .map(([key, value]) => <DataCard key={key} title={key.replaceAll("_", " ")} value={value} />)}
        {data.induction && <DataCard title="induction" value={data.induction} />}
      </div>
      {!data.parsed_bundle && <p className="text-muted-foreground">Parse the selected evidence to view the structures its parser found: Master Sector, HIKBTREE and System Logs on Hikvision disks, or index, filesystem entries and carved runs on others.</p>}
    </div>}

    {(mode === "recovery" || mode === "explorer") && !!rows.length && <TimeCard settings={timeSettings} onSave={saveTime} disabled={busy} />}
    {mode === "recovery" && <Card><CardHeader><CardTitle>Recordings ({rows.length})</CardTitle></CardHeader><CardContent className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <Tabs value={tab} onValueChange={setTab}><TabsList>
          {recoveryTabs.map(([value, label]) => <TabsTrigger key={value} value={value} className="gap-2">{label}
            <span className="text-caption text-muted-foreground tnum">{rows.filter(r => inTab(r, value)).length}</span></TabsTrigger>)}
        </TabsList></Tabs>
        <Button disabled={busy || !pending.length} onClick={() => run("extract", pending.map(r => r.id))}>Recover and check all ({pending.length})</Button>
      </div>
      <div className="max-h-[32rem] overflow-auto"><Table><TableHeader><TableRow>
        <TableHead>Clip</TableHead><TableHead>Recovered as</TableHead><TableHead>Recorded (recorder clock, UTC)</TableHead><TableHead>Quality gate</TableHead><TableHead><span className="sr-only">Actions</span></TableHead>
      </TableRow></TableHeader><TableBody>{rows.filter(r => inTab(r, tab)).map(r => {
        const gate = gateOf(r), state = stateOf(r), output = data[`extraction_${r.id}`]?.output
        return <TableRow key={r.id}>
          <TableCell><div className="space-y-1"><p className="font-medium">{r.channel != null ? `Channel ${r.channel}` : "Channel unknown"}</p>
            <p className="max-w-64 truncate font-mono text-caption text-muted-foreground" title={r.path ?? r.offset}>{r.path ?? r.offset}</p></div></TableCell>
          <TableCell><span className="inline-flex items-center gap-2"><StateDot state={state} /> {stateLabel[state]}</span></TableCell>
          <TableCell className="tnum"><div className="space-y-1"><p>{r.start ?? "Not available"}</p>{r.end && r.end !== r.start && <p className="text-caption text-muted-foreground">to {r.end}</p>}
            {utc(r.start) && <p className="text-caption text-muted-foreground">= {utc(r.start)}</p>}</div></TableCell>
          <TableCell>{!gate ? <span className="text-muted-foreground">Not checked</span> : gate.result === "passed"
            ? <Badge variant="success">Passed, {gate.frames} frames</Badge>
            : <div className="space-y-1"><Badge variant="warning">Excluded</Badge><p className="max-w-56 text-caption whitespace-normal text-muted-foreground">{gate.reason}</p></div>}</TableCell>
          <TableCell className="text-right"><Button size="sm" variant="outline" disabled={busy || state === "empty"}
            onClick={() => output ? setPreview(output) : run("extract", [r.id])}>{output ? "View" : gate ? "Retry" : "Recover"}</Button></TableCell>
        </TableRow>})}</TableBody></Table></div>
      {!rows.length && <p className="text-muted-foreground">No recordings yet. <Link className="underline" to={`/cases/${caseId}/parsing`}>Parse the evidence</Link> first.</p>}
      <p className="text-caption text-muted-foreground">Each recovered clip is decode-checked on its first, middle and last frame. Excluded clips are kept and listed; they are only held back from analytics.</p>
      {preview && <div className="space-y-3"><SurveillancePlayer src={api.outputFileUrl(preview)} /><a className="underline" href={api.outputFileUrl(preview)} download>Download viewing copy</a></div>}
    </CardContent></Card>}

    {mode === "explorer" && <Card><CardHeader><CardTitle>Recordings ({rows.length})</CardTitle></CardHeader><CardContent className="space-y-5">
      <div className="flex gap-3"><Button disabled={busy || !selected.size} onClick={() => run("extract", [...selected])}>Extract selected ({selected.size})</Button>
        <Button variant="outline" disabled={busy || !playable.length} onClick={() => run("extract", playable.map(r => r.id))}>Extract all</Button></div>
      <div className="max-h-96 overflow-auto"><Table><TableHeader><TableRow>
        <TableHead><Checkbox aria-label="Select all recordings" disabled={busy || !playable.length} checked={!!playable.length && playable.every(r => selected.has(r.id))} onCheckedChange={v => setSelected(v === true ? new Set(playable.map(r => r.id)) : new Set())} /></TableHead>
        <TableHead>Channel</TableHead><TableHead>Start (recorder clock)</TableHead><TableHead>Start (UTC)</TableHead><TableHead>End</TableHead><TableHead>Offset</TableHead><TableHead>Status</TableHead><TableHead>Video</TableHead>
      </TableRow></TableHeader><TableBody>{rows.map(r => <TableRow key={r.id}>
        <TableCell><Checkbox aria-label={`Select recording ${r.id}`} checked={selected.has(r.id)} disabled={busy || r.status === "No Video/Recording"} onCheckedChange={v => setSelected(s => { const next = new Set(s); if (v === true) next.add(r.id); else next.delete(r.id); return next })} /></TableCell>
        <TableCell>{r.channel ?? "Unknown"}</TableCell><TableCell>{r.start ?? "Not available"}</TableCell><TableCell className="tnum">{utc(r.start) ?? "Not available"}</TableCell><TableCell>{r.end ?? "Not available"}</TableCell><TableCell className="font-mono">{r.offset}</TableCell><TableCell>{r.status}</TableCell>
        <TableCell><Button size="sm" variant="outline" disabled={busy || r.status === "No Video/Recording"} onClick={() => data[`extraction_${r.id}`]?.output ? setPreview(data[`extraction_${r.id}`].output) : run("extract", [r.id])}>View video</Button></TableCell>
      </TableRow>)}</TableBody></Table></div>
      {!rows.length && <p className="text-muted-foreground">No recordings saved. Parse evidence first.</p>}
      {preview && <div className="space-y-3"><SurveillancePlayer src={api.outputFileUrl(preview)} /><a className="underline" href={api.outputFileUrl(preview)} download>Download viewing copy</a></div>}
    </CardContent></Card>}
    {(data.warnings ?? []).map((warning: string) => <p key={warning} className="text-caption text-muted-foreground">{warning}</p>)}
    <LogPanel lines={logs} onClear={() => setLogs([])} empty="Run an evidence task to see its progress." />
  </div>
}
