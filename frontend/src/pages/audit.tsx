import { useMemo, useState } from "react"
import type { DateRange } from "react-day-picker"
import { SealCheckIcon } from "@phosphor-icons/react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { DateRangePicker } from "@/components/pramaan/date-picker"
import { PageHeader } from "@/components/pramaan/page-header"
import { auditAll, cases } from "@/lib/mock"

export default function AuditPage() {
  const [caseId, setCaseId] = useState("all")
  const [range, setRange] = useState<DateRange>()
  const rows = useMemo(() => [...auditAll].sort((a, b) => b.seq - a.seq).filter((r) => {
    if (caseId !== "all" && r.caseId !== caseId) return false
    const d = new Date(r.d)
    if (range?.from && d < range.from) return false
    if (range?.to && d > range.to) return false
    return true
  }), [caseId, range])

  return (
    <div className="space-y-10">
      <PageHeader
        eyebrow="Workspace"
        title="Audit trail"
        description="Every entry carries the hash of the one before it. Change or remove an entry and the chain stops matching."
        actions={
          <>
            <Badge variant="success"><SealCheckIcon weight="fill" /> Chain intact</Badge>
            <Button variant="outline" onClick={() => toast.success("Chain verified", { description: `${auditAll.length} entries re-hashed, no mismatch.` })}>
              Verify chain
            </Button>
          </>
        }
      />

      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-3">
          <Select value={caseId} onValueChange={setCaseId}>
            <SelectTrigger className="w-64" aria-label="Case">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All cases</SelectItem>
              {cases.slice(0, 3).map((c) => (
                <SelectItem key={c.id} value={c.id}>{c.id}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DateRangePicker value={range} onChange={setRange} placeholder="Any date" className="w-64" />
        </div>

        <div className="overflow-hidden rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-6">#</TableHead>
                <TableHead>When</TableHead>
                <TableHead>Who</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Case</TableHead>
                <TableHead className="pr-6 text-right">Previous → hash</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.seq}>
                  <TableCell className="pl-6 font-mono text-caption text-muted-foreground tnum">{r.seq}</TableCell>
                  <TableCell className="tnum">{r.t}</TableCell>
                  <TableCell className="text-muted-foreground">{r.who}</TableCell>
                  <TableCell>{r.action}</TableCell>
                  <TableCell className="font-mono text-caption">{r.caseId}</TableCell>
                  <TableCell className="pr-6 text-right font-mono text-caption text-muted-foreground">
                    {r.prev} → <span className="text-foreground">{r.hash}</span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  )
}
