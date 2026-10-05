import { useEffect, useState } from "react"
import { BrainIcon } from "@phosphor-icons/react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { PageHeader } from "@/components/pramaan/page-header"
import { api, type ApiFingerprint, type FingerprintMatch } from "@/lib/api"

const statusTone: Record<string, "neutral" | "warning" | "success" | "danger"> = {
  OBSERVED: "neutral", CANDIDATE: "warning", VALIDATED: "success", REJECTED: "danger", DEPRECATED: "neutral",
}
const statusMeaning: Record<string, string> = {
  OBSERVED: "Seen once. Not corroborated.",
  CANDIDATE: "Seen on more than one piece of evidence. Still needs a person to confirm it.",
  VALIDATED: "An analyst confirmed this layout by hand.",
  REJECTED: "An analyst ruled this out. It will not be matched again.",
  DEPRECATED: "Superseded. Kept for the record.",
}

function Tokens({ label, items, tone }: { label: string; items: string[]; tone?: string }) {
  if (!items.length) return null
  return <div className="space-y-1">
    <p className="text-caption text-muted-foreground">{label}</p>
    <div className="flex flex-wrap gap-1">{items.map(t => <code key={t} className={`rounded px-1.5 py-0.5 text-caption ${tone ?? "bg-muted"}`}>{t}</code>)}</div>
  </div>
}

function FingerprintCard({ fp, onChange }: { fp: ApiFingerprint; onChange: () => void }) {
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [similar, setSimilar] = useState<FingerprintMatch[] | null>(null)

  const decide = async (status: string) => {
    setBusy(true)
    try { await api.setFingerprintStatus(fp.id, status, note || undefined); toast.success(`Marked ${status.toLowerCase()}`); onChange() }
    catch (e) { toast.error(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  const canValidate = fp.status === "OBSERVED" || fp.status === "CANDIDATE"
  return <Card>
    <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
      <div className="space-y-1">
        <CardTitle>#{fp.id} · {fp.label}</CardTitle>
        <p className="text-caption text-muted-foreground">{statusMeaning[fp.status]}</p>
      </div>
      <Badge variant={statusTone[fp.status] ?? "neutral"}>{fp.status}</Badge>
    </CardHeader>
    <CardContent className="space-y-4">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-caption sm:grid-cols-4">
        <div><dt className="text-muted-foreground">Confidence</dt><dd className="tnum">{fp.confidence.toFixed(2)}</dd></div>
        <div><dt className="text-muted-foreground">Observations</dt><dd className="tnum">{fp.observations}</dd></div>
        <div><dt className="text-muted-foreground">Engine</dt><dd className="tnum">{fp.parser_version}</dd></div>
        <div><dt className="text-muted-foreground">Last seen</dt><dd className="tnum">{fp.last_seen.replace("T", " ").slice(0, 19)}</dd></div>
      </dl>

      <Tokens label={`Observed traits (${fp.tokens.length})`} items={fp.tokens} />

      <div className="space-y-1">
        <p className="text-caption text-muted-foreground">Seen on</p>
        {fp.sources.map(s => <p key={`${s.imageFileId}`} className="text-caption">
          {s.filename} <span className="text-muted-foreground">· case {s.caseId} · {s.at.slice(0, 10)}{s.sha256 ? ` · SHA-256 ${s.sha256.slice(0, 10)}…` : ""}</span>
        </p>)}
      </div>

      {fp.note && <p className="rounded-md bg-muted p-3 text-caption">Analyst note: {fp.note}</p>}

      {similar && <div className="space-y-2 rounded-md border p-3">
        {similar.length ? similar.map(m => <div key={m.id} className="space-y-1">
          <p className="text-caption">#{m.id} {m.label} — <span className="tnum">{(m.similarity * 100).toFixed(0)}% of traits agree</span>{m.requires_validation && " · needs checking"}</p>
          <Tokens label="Agreeing" items={m.shared} tone="bg-success/15" />
          <Tokens label="Only here" items={m.only_in_stored_record} tone="bg-warning/15" />
        </div>) : <p className="text-caption text-muted-foreground">No other record shares enough traits to be worth comparing.</p>}
      </div>}

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" size="sm" disabled={busy}
          onClick={async () => setSimilar((await api.knowledgeSimilar(fp.id)).data.matches)}>Find similar</Button>
        {canValidate && <>
          <Input className="h-9 w-72" placeholder="What did you check? (saved with the decision)" value={note} onChange={e => setNote(e.target.value)} />
          <Button size="sm" disabled={busy} onClick={() => decide("VALIDATED")}>Confirm this layout</Button>
        </>}
        {fp.status !== "REJECTED" && <Button variant="outline" size="sm" disabled={busy} onClick={() => decide("REJECTED")}>Reject</Button>}
      </div>
    </CardContent>
  </Card>
}

export default function KnowledgePage() {
  const [rows, setRows] = useState<ApiFingerprint[]>([])
  const [version, setVersion] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)

  const load = () => api.knowledge().then(r => { setRows(r.data); setVersion(r.knowledge_db_version); setError("") })
    .catch(e => setError(e instanceof Error ? e.message : String(e))).finally(() => setLoading(false))
  useEffect(() => { load() }, [])

  const counts = rows.reduce<Record<string, number>>((a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }), {})

  return (
    <div className="space-y-10">
      <PageHeader
        eyebrow="Workspace"
        title="Knowledge base"
        description="Traits observed on evidence already analysed, kept so a later image can be compared against them. A match is a lead for an investigator to check, never an identification on its own. Nothing here holds footage."
        actions={<Badge variant="neutral"><BrainIcon weight="fill" /> {rows.length} record{rows.length === 1 ? "" : "s"}{version && ` · ${version}`}</Badge>}
      />

      {error && <p role="alert" className="text-destructive">{error}</p>}

      {!!rows.length && <div className="flex flex-wrap gap-2">
        {["OBSERVED", "CANDIDATE", "VALIDATED", "REJECTED"].filter(s => counts[s]).map(s =>
          <Badge key={s} variant={statusTone[s]}>{counts[s]} {s.toLowerCase()}</Badge>)}
      </div>}

      <div className="space-y-6">
        {rows.map(fp => <FingerprintCard key={fp.id} fp={fp} onChange={load} />)}
      </div>

      {!rows.length && !loading && <Card><CardContent className="p-6 text-muted-foreground">
        Nothing learned yet. Parsing a piece of evidence records the traits of its storage layout here. When a second
        image shows the same traits, the two are linked and the record moves to <strong>candidate</strong>, which you can
        then confirm or reject.
      </CardContent></Card>}
    </div>
  )
}
