import { useEffect, useMemo, useState } from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { format } from "date-fns"
import type { DateRange } from "react-day-picker"
import { MagnifyingGlassIcon, PlusIcon, XIcon } from "@phosphor-icons/react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldGroup, FieldLabel, FieldDescription } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle, EmptyContent } from "@/components/ui/empty"
import { DatePicker, DateRangePicker } from "@/components/pramaan/date-picker"
import { PageHeader } from "@/components/pramaan/page-header"
import { StageBadge } from "@/components/pramaan/status"
import type { CaseStage } from "@/lib/mock"
import { api, type ApiCase } from "@/lib/api"

const stages: CaseStage[] = ["Intake", "Parsing", "Recovering", "Analysing", "Report ready", "Sealed"]

// Real cases only carry name/description/created_at. The rest of this page's columns
// (stage, FIR, station, examiner) belong to forensic stages that are still mocked
// elsewhere, so we fill them with case-agnostic defaults instead of inventing a stage engine.
function toRow(c: ApiCase) {
  return {
    id: String(c.id),
    title: c.name,
    fir: "",
    station: "",
    examiner: "",
    stage: "Intake" as CaseStage,
    evidence: 0,
    opened: c.created_at,
    updated: c.created_at,
  }
}

export default function CasesPage() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [query, setQuery] = useState("")
  const [stage, setStage] = useState("all")
  const [range, setRange] = useState<DateRange>()
  const [cases, setCases] = useState<ReturnType<typeof toRow>[]>([])
  const newOpen = params.get("new") === "1"

  async function reload() {
    try {
      const res = await api.listCases()
      setCases(res.data.map(toRow))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load cases")
    }
  }
  useEffect(() => {
    reload()
  }, [])

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return cases.filter((c) => {
      if (stage !== "all" && c.stage !== stage) return false
      if (q && !`${c.id} ${c.title} ${c.fir} ${c.station}`.toLowerCase().includes(q)) return false
      const d = new Date(c.opened)
      if (range?.from && d < range.from) return false
      if (range?.to && d > range.to) return false
      return true
    })
  }, [query, stage, range, cases])

  const filtered = query || stage !== "all" || range?.from
  const clear = () => {
    setQuery("")
    setStage("all")
    setRange(undefined)
  }

  return (
    <div className="space-y-10">
      <PageHeader
        eyebrow="Workspace"
        title="Cases"
        description="Every case keeps its own evidence, hashes and audit chain. Open one to continue where you stopped."
        actions={
          <Button onClick={() => setParams({ new: "1" })}>
            <PlusIcon weight="bold" />
            New case
          </Button>
        }
      />

      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-3">
          <InputGroup className="h-10 w-80 bg-card">
            <InputGroupAddon>
              <MagnifyingGlassIcon />
            </InputGroupAddon>
            <InputGroupInput
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Case number, FIR or station"
              aria-label="Search cases"
            />
          </InputGroup>

          <Select value={stage} onValueChange={setStage}>
            <SelectTrigger className="w-44" aria-label="Filter by stage">
              <SelectValue placeholder="Stage" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All stages</SelectItem>
              {stages.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <DateRangePicker value={range} onChange={setRange} placeholder="Opened, any date" className="w-64" />

          {filtered && (
            <Button variant="ghost" size="sm" onClick={clear} className="text-muted-foreground">
              <XIcon /> Clear
            </Button>
          )}
          <p className="ml-auto text-caption text-muted-foreground tnum">
            {rows.length} of {cases.length} cases
          </p>
        </div>

        <div className="overflow-hidden rounded-lg border bg-card">
          {rows.length ? (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-6">Case</TableHead>
                  <TableHead>Stage</TableHead>
                  <TableHead>Examiner</TableHead>
                  <TableHead className="text-right">Evidence</TableHead>
                  <TableHead className="pr-6 text-right">Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((c) => (
                  <TableRow
                    key={c.id}
                    tabIndex={0}
                    onClick={() => navigate(`/cases/${c.id}`)}
                    onKeyDown={(e) => e.key === "Enter" && navigate(`/cases/${c.id}`)}
                    className="cursor-pointer outline-none focus-visible:bg-primary-soft"
                  >
                    <TableCell className="pl-6">
                      <div className="space-y-1">
                        <p className="font-medium">{c.title}</p>
                        <p className="text-caption text-muted-foreground">
                          <span className="font-mono">{c.id}</span>
                          <span aria-hidden className="mx-2">·</span>
                          {c.fir}
                          <span aria-hidden className="mx-2">·</span>
                          {c.station}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <StageBadge stage={c.stage} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">{c.examiner}</TableCell>
                    <TableCell className="text-right tnum">{c.evidence}</TableCell>
                    <TableCell className="pr-6 text-right text-muted-foreground tnum">
                      {format(new Date(c.updated), "dd MMM")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Empty className="border-0 py-16">
              <EmptyHeader>
                <EmptyTitle className="font-display text-heading">No case matches those filters</EmptyTitle>
                <EmptyDescription>Widen the date range, or search by the FIR number instead.</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button variant="outline" onClick={clear}>
                  Clear filters
                </Button>
              </EmptyContent>
            </Empty>
          )}
        </div>
      </div>

      <NewCaseDialog open={newOpen} onOpenChange={(o) => (o ? setParams({ new: "1" }) : setParams({}))} onCreated={reload} />
    </div>
  )
}

function NewCaseDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: () => void }) {
  const [incident, setIncident] = useState<Date>()
  const [title, setTitle] = useState("")
  const [fir, setFir] = useState("")
  const [station, setStation] = useState("")

  const navigate = useNavigate()
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    try {
      const description = [fir, station].filter(Boolean).join(" · ") || undefined
      const res = await api.createCase(title || "Untitled case", description)
      toast.success("Case created", { description: `Case #${res.data.id} is open. Start with evidence.` })
      onOpenChange(false)
      onCreated()
      navigate(`/cases/${res.data.id}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create case")
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="space-y-8">
          <DialogHeader className="space-y-2">
            <DialogTitle className="font-display text-heading font-normal">New case</DialogTitle>
            <DialogDescription>
              These details appear on the Section 63 certificate. You can correct them later; every change is logged.
            </DialogDescription>
          </DialogHeader>

          <FieldGroup className="gap-5">
            <Field>
              <FieldLabel htmlFor="title">Case title</FieldLabel>
              <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Jewellery store burglary, Shivaji Nagar" required />
            </Field>

            <div className="grid grid-cols-2 gap-4">
              <Field>
                <FieldLabel htmlFor="fir">FIR / crime number</FieldLabel>
                <Input id="fir" value={fir} onChange={(e) => setFir(e.target.value)} placeholder="0142/2026" className="font-mono text-caption" />
              </Field>
              <Field>
                <FieldLabel>Incident date</FieldLabel>
                <DatePicker value={incident} onChange={setIncident} placeholder="Pick a date" className="w-full" />
              </Field>
            </div>

            <Field>
              <FieldLabel>Police station</FieldLabel>
              <Select onValueChange={setStation}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select station" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="shivaji">Shivaji Nagar PS, Pune</SelectItem>
                  <SelectItem value="koregaon">Koregaon Park PS, Pune</SelectItem>
                  <SelectItem value="cubbon">Cubbon Park PS, Bengaluru</SelectItem>
                  <SelectItem value="noida20">Sector 20 PS, Noida</SelectItem>
                </SelectContent>
              </Select>
              <FieldDescription>Not listed? Stations are managed in lab settings.</FieldDescription>
            </Field>
          </FieldGroup>

          <DialogFooter className="gap-3 sm:gap-3">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">Create case</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
