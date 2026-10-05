import { useEffect, useMemo, useState } from "react"
import type { DateRange } from "react-day-picker"
import { SealCheckIcon, WarningIcon } from "@phosphor-icons/react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { DateRangePicker } from "@/components/pramaan/date-picker"
import { PageHeader } from "@/components/pramaan/page-header"
import { api, type CustodyChain } from "@/lib/api"

const short = (h: string) => h.slice(0, 10)

export default function AuditPage() {
  const [chains, setChains] = useState<CustodyChain[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [caseId, setCaseId] = useState("all")
  const [range, setRange] = useState<DateRange>()

  const load = () => api.custody().then(r => { setChains(r.data); setError("") }).catch(e => setError(e instanceof Error ? e.message : String(e))).finally(() => setLoading(false))
  useEffect(() => { load() }, [])

  const broken = chains.filter(c => !c.valid)
  const total = chains.reduce((n, c) => n + c.events.length, 0)
  const rows = useMemo(() => chains.filter(c => caseId === "all" || String(c.caseId) === caseId)
    .flatMap(c => c.events.map(e => ({ ...e, caseName: c.caseName, bad: !c.valid && c.brokenAt !== null && e.seq >= c.brokenAt })))
    .filter(e => {
      const d = new Date(e.ts)
      return !(range?.from && d < range.from) && !(range?.to && d > new Date(range.to.getTime() + 864e5 - 1))
    }).sort((a, b) => b.ts.localeCompare(a.ts)), [chains, caseId, range])

  return (
    <div className="space-y-10">
      <PageHeader
        eyebrow="Workspace"
        title="Audit trail"
        description="Every entry carries the hash of the one before it, per case. Change or remove an entry and the chain stops matching. The hashes are not signed, so this exposes tampering by anyone without database access, not by someone who can rewrite the whole chain."
        actions={
          <>
            {!loading && (broken.length
              ? <Badge variant="danger"><WarningIcon weight="fill" /> Chain broken in {broken.length} case{broken.length > 1 ? "s" : ""}</Badge>
              : <Badge variant="success"><SealCheckIcon weight="fill" /> Chain intact</Badge>)}
            <Button variant="outline" onClick={async () => { await load(); toast.success("Chains re-checked", { description: `${total} entries re-hashed from the database.` }) }}>
              Verify chain
            </Button>
          </>
        }
      />

      {error && <p role="alert" className="text-destructive">{error}</p>}
      {broken.map(c => <p key={c.caseId} role="alert" className="text-destructive">Case {c.caseId} ({c.caseName}): {c.message}.</p>)}

      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-3">
          <Select value={caseId} onValueChange={setCaseId}>
            <SelectTrigger className="w-64" aria-label="Case"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All cases</SelectItem>
              {chains.map(c => <SelectItem key={c.caseId} value={String(c.caseId)}>{c.caseName}</SelectItem>)}
            </SelectContent>
          </Select>
          <DateRangePicker value={range} onChange={setRange} placeholder="Any date" className="w-64" />
        </div>

        <div className="overflow-hidden rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-6">#</TableHead>
                <TableHead>When (UTC)</TableHead>
                <TableHead>Who</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Case</TableHead>
                <TableHead className="pr-6 text-right">Previous → hash</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(r => (
                <TableRow key={`${r.caseId}-${r.seq}`} className={r.bad ? "bg-destructive/10" : undefined}>
                  <TableCell className="pl-6 font-mono text-caption text-muted-foreground tnum">{r.seq}</TableCell>
                  <TableCell className="tnum">{r.ts.replace("T", " ").slice(0, 19)}</TableCell>
                  <TableCell className="text-muted-foreground">{r.actor}</TableCell>
                  <TableCell>
                    <p>{r.action}</p>
                    {(r.filename || r.detail) && <p className="max-w-md text-caption whitespace-normal text-muted-foreground">{[r.filename, r.detail].filter(Boolean).join(" · ")}</p>}
                    {r.sha256 && <p className="font-mono text-caption text-muted-foreground" title={r.sha256}>SHA-256 {short(r.sha256)}…</p>}
                  </TableCell>
                  <TableCell className="text-caption">{r.caseName}</TableCell>
                  <TableCell className="pr-6 text-right font-mono text-caption text-muted-foreground" title={`${r.prev_hash} → ${r.event_hash}`}>
                    {short(r.prev_hash)} → <span className="text-foreground">{short(r.event_hash)}</span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!rows.length && !loading && <p className="p-6 text-muted-foreground">No custody events yet. Opening a case, adding evidence and running tasks are recorded here.</p>}
        </div>
      </div>
    </div>
  )
}
