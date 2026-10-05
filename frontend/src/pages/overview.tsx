import { useEffect, useMemo, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { format } from "date-fns"
import { ArrowRightIcon, LinkSimpleIcon, PlusIcon, SealCheckIcon, WarningIcon } from "@phosphor-icons/react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { HashValue } from "@/components/pramaan/hash-value"
import { PageHeader, Section } from "@/components/pramaan/page-header"
import { StepIcon, footageSwatch } from "@/components/pramaan/status"
import { api, getUser, type ApiCase } from "@/lib/api"
import { clockSources, coverageView, useCaseData, type Kind } from "@/lib/case-data"
import { cn } from "@/lib/utils"

const swatch: Record<Kind, string> = { ...footageSwatch, unknown: "border border-dashed border-foreground/40 bg-transparent" }
const kinds: { kind: Kind; label: string; hint: string }[] = [
  { kind: "live", label: "Live", hint: "Listed in the recorder's index" },
  { kind: "deleted", label: "Deleted", hint: "Removed from the index, found on the disk" },
  { kind: "excluded", label: "Excluded", hint: "Failed the quality gate" },
  { kind: "unknown", label: "Not classed", hint: "The index does not say live or deleted" },
]

type Step = { key: string; label: string; module: string; state: "done" | "active" | "todo" | "attention"; result: string }
type Attention = { id: string; title: string; detail: string; action: string; to: string; urgent?: boolean }

export default function OverviewPage() {
  const { caseId = "" } = useParams()
  const [real, setReal] = useState<ApiCase | null>(null)
  const data = useCaseData(caseId)
  useEffect(() => { if (caseId) api.getCase(caseId).then((r) => setReal(r.data)).catch(() => setReal(null)) }, [caseId])

  const view = useMemo(() => {
    const { evidence, recordings, analysis, custody } = data
    const recovered = recordings.filter((r) => r.recovered)
    const excluded = recordings.filter((r) => r.kind === "excluded")
    const unrecoveredDeleted = recordings.filter((r) => r.kind === "deleted" && !r.recovered)
    const timed = recordings.filter((r) => r.startMs !== null)
    const clocks = clockSources(data, "utc")
    const uncovered = coverageView(data).filter((c) => c.done < c.total)
    const unparsed = evidence.filter((e) => !e.parsed)
    const unhashed = evidence.filter((e) => !e.sha256)
    const mismatched = evidence.filter((e) => e.integrity?.matches === false)
    const reportEvents = custody?.events.filter((e) => e.action === "Report generated") ?? []
    const brands = [...new Set(evidence.map((e) => e.vendor?.brand).filter(Boolean))] as string[]
    const cameras = new Set(recordings.map((r) => `${r.imageId}:${r.channel}`)).size

    const attention: Attention[] = [
      mismatched.length && { id: "integrity", urgent: true, title: "An evidence file no longer matches its intake hash", detail: `${mismatched.map((e) => e.image.filename).join(", ")}. Treat any result from it with caution.`, action: "Review evidence", to: "evidence" },
      custody && !custody.valid && { id: "custody", urgent: true, title: "The audit trail does not verify", detail: custody.message, action: "Open audit trail", to: "/audit" },
      !evidence.length && { id: "none", title: "No evidence has been added", detail: "Add a disk image or recorder file to begin.", action: "Add evidence", to: "evidence" },
      unhashed.length && { id: "hash", title: `${unhashed.length} evidence item(s) have no intake hash`, detail: unhashed.map((e) => e.image.filename).join(", "), action: "Review evidence", to: "evidence" },
      unparsed.length && evidence.length && { id: "parse", title: `${unparsed.length} evidence item(s) not parsed yet`, detail: unparsed.map((e) => e.image.filename).join(", "), action: "Parse evidence", to: "parsing" },
      unrecoveredDeleted.length && { id: "recover", title: `${unrecoveredDeleted.length} deleted recording(s) not recovered yet`, detail: "They are listed in the index but have not been extracted and decode-checked.", action: "Recover footage", to: "recovery" },
      excluded.length && { id: "excluded", title: `${excluded.length} recording(s) failed the quality gate`, detail: "They stay in the report as recovered, not analysed.", action: "Review recordings", to: "recovery" },
      recovered.length && uncovered.length && { id: "analyse", title: "Some recovered recordings have not been analysed", detail: uncovered.map((c) => `${c.label}: ${c.done} of ${c.total}`).join("; "), action: "Open analytics", to: "analytics" },
      timed.length && evidence.some((e) => e.parsed && !e.timeSet) && { id: "time", title: "Recorder time is read as India time with no drift", detail: "If the recorder used another time zone or its clock was off, set that on the Recovery page. Otherwise absolute times are wrong by that amount.", action: "Set time zone", to: "recovery" },
    ].filter(Boolean) as Attention[]

    const state = (done: boolean, started: boolean, problem = false): Step["state"] => problem ? "attention" : done ? "done" : started ? "active" : "todo"
    const pipeline: Step[] = [
      { key: "intake", label: "Intake", module: "M0", state: state(evidence.length > 0 && !unhashed.length, evidence.length > 0, mismatched.length > 0),
        result: evidence.length ? `${evidence.length} image(s) hashed, MD5 and SHA-256` : "No evidence yet" },
      { key: "identify", label: "Identify", module: "M1", state: state(evidence.some((e) => e.identified || e.parsed), evidence.length > 0),
        result: brands.length ? brands.join(", ") : evidence.some((e) => e.identified || e.parsed) ? "Format found, brand not determined" : "Not run" },
      { key: "parse", label: "Parse", module: "M2 · M3", state: state(evidence.length > 0 && !unparsed.length, data.parsed.length > 0, false),
        result: data.parsed.length ? `${recordings.length} recording(s) listed from ${data.parsed.length} image(s)` : "Not run" },
      { key: "recover", label: "Recover", module: "M4", state: state(recordings.length > 0 && !unrecoveredDeleted.length && recovered.length > 0, recordings.length > 0),
        result: recovered.length ? `${recovered.length} recovered, ${recovered.filter((r) => r.kind === "deleted").length} from deleted footage` : recordings.length ? "Nothing recovered yet" : "Not started" },
      { key: "validate", label: "Validate", module: "M4.5", state: state(recovered.length > 0, false, excluded.length > 0),
        result: recovered.length ? `${recovered.length - excluded.length} passed, ${excluded.length} excluded` : "Nothing to check yet" },
      { key: "timeline", label: "Timeline", module: "M6", state: state(timed.length > 0 && clocks.every((c) => c.available), timed.length > 0),
        result: timed.length ? `${timed.length} recording(s) timed; ${clocks.filter((c) => c.available).length} of ${clocks.length} clock sources` : "No recorder times found" },
      { key: "analyse", label: "Analyse", module: "M7", state: state(analysis.length > 0 && !uncovered.length, analysis.length > 0),
        result: analysis.length ? `${analysis.length} run(s) saved` : "Not started" },
      { key: "report", label: "Report", module: "M9", state: state(reportEvents.length > 0, false),
        result: reportEvents.length ? `Generated ${format(new Date(reportEvents[reportEvents.length - 1].ts), "d MMM yyyy, HH:mm")}` : "Not generated" },
    ]

    const counts = Object.fromEntries(kinds.map(({ kind }) => [kind, recordings.filter((r) => r.kind === kind).length])) as Record<Kind, number>
    return { attention, pipeline, counts, cameras, total: recordings.length, custody }
  }, [data])

  const user = getUser()
  const title = real?.name ?? `Case ${caseId}`
  const head = view.custody?.events.at(-1)
  const recent = [...(view.custody?.events ?? [])].reverse().slice(0, 5)

  return (
    <div className="space-y-14">
      <PageHeader
        eyebrow={<span className="font-mono normal-case">{caseId}</span>}
        title={title}
        description={real ? `${real.description ? `${real.description}. ` : ""}Examiner ${user?.username ?? "unknown"}, opened ${format(new Date(real.created_at), "d MMMM yyyy")}.` : "Loading the case…"}
        actions={
          <>
            <Button variant="outline" asChild><Link to="evidence"><PlusIcon /> Add evidence</Link></Button>
            <Button asChild><Link to="timeline">Continue to timeline <ArrowRightIcon weight="bold" /></Link></Button>
          </>
        }
      />
      {data.error && <p role="alert" className="text-destructive">{data.error}</p>}

      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-8">
          {/* Honest reporting: what was skipped or uncertain comes first. */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2.5">
                Needs your attention
                <Badge variant={view.attention.some((a) => a.urgent) ? "danger" : view.attention.length ? "warning" : "success"} className="tnum">{view.attention.length}</Badge>
              </CardTitle>
              <CardDescription>Nothing is skipped silently. These stay visible in the report until resolved.</CardDescription>
            </CardHeader>
            <CardContent className="divide-y divide-hairline">
              {view.attention.map((a) => (
                <div key={a.id} className="flex items-start gap-4 py-5 first:pt-1 last:pb-0">
                  <WarningIcon weight="fill" className={cn("mt-0.5 size-5 shrink-0", a.urgent ? "text-destructive" : "text-warning")} />
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="font-medium">{a.title}</p>
                    <p className="text-body text-muted-foreground">{a.detail}</p>
                  </div>
                  <Button variant="outline" size="sm" asChild className="shrink-0"><Link to={a.to}>{a.action}</Link></Button>
                </div>
              ))}
              {!view.attention.length && <p className="text-muted-foreground">{data.loading ? "Loading…" : "Nothing needs attention right now."}</p>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Pipeline</CardTitle>
              <CardDescription>From sealed disk image to a court-ready report.</CardDescription>
            </CardHeader>
            <CardContent>
              <ol className="divide-y divide-hairline">
                {view.pipeline.map((s) => (
                  <li key={s.key} className="flex items-center gap-4 py-3.5 first:pt-1 last:pb-0">
                    <StepIcon state={s.state} />
                    <div className="w-28 shrink-0"><p className={cn("font-medium", s.state === "todo" && "text-muted-foreground")}>{s.label}</p></div>
                    <p className="min-w-0 flex-1 truncate text-body text-muted-foreground" title={s.result}>{s.result}</p>
                    <span className="font-mono text-caption text-muted-foreground">{s.module}</span>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-8">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <SealCheckIcon weight="fill" className={cn("size-5", view.custody && !view.custody.valid ? "text-destructive" : "text-success")} />
                Evidence integrity
              </CardTitle>
              <CardDescription>Hashed on intake, re-verified when you check it.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {data.evidence.map((e) => (
                <div key={e.image.id} className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-body font-medium" title={e.image.filename}>{e.image.filename}</p>
                    <span className="shrink-0 font-mono text-caption whitespace-nowrap text-muted-foreground">EV-{e.image.id}</span>
                  </div>
                  <dl className="grid grid-cols-[4.25rem_1fr] items-center gap-y-0.5 text-caption">
                    <dt className="text-muted-foreground">MD5</dt>
                    <dd>{e.md5 ? <HashValue value={e.md5} label="MD5" /> : <span className="text-muted-foreground">not recorded</span>}</dd>
                    <dt className="text-muted-foreground">SHA-256</dt>
                    <dd>{e.sha256 ? <HashValue value={e.sha256} label="SHA-256" /> : <span className="text-muted-foreground">pending</span>}</dd>
                    <dt className="text-muted-foreground">Re-check</dt>
                    <dd className={cn(e.integrity?.matches === false && "font-medium text-destructive")}>
                      {e.integrity === null ? "not run yet" : e.integrity.matches === true ? "matches intake" : e.integrity.matches === false ? "DOES NOT MATCH" : "no intake hash"}
                    </dd>
                  </dl>
                </div>
              ))}
              {!data.evidence.length && <p className="text-muted-foreground">{data.loading ? "Loading…" : "No evidence added yet."}</p>}
              <div className="flex items-center gap-2 border-t border-hairline pt-4 text-caption text-muted-foreground">
                <LinkSimpleIcon className="size-4 shrink-0" />
                {head ? (
                  <span>Audit chain head <code className="font-mono text-foreground">{head.event_hash.slice(0, 10)}</code>, {view.custody?.valid ? "verified" : <strong className="text-destructive">NOT verified</strong>}</span>
                ) : <span>No audit entries yet</span>}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Recordings</CardTitle>
              <CardDescription className="tnum">{view.total} recording(s) across {view.cameras} camera(s)</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-muted" role="img" aria-label="Recordings by state">
                {view.total > 0 && kinds.filter((k) => view.counts[k.kind]).map((k) => (
                  <span key={k.kind} className={cn("h-full", swatch[k.kind])} style={{ flexBasis: `${(view.counts[k.kind] / view.total) * 100}%` }} />
                ))}
              </div>
              <ul className="space-y-3">
                {kinds.map((k) => (
                  <li key={k.kind} className="flex items-baseline gap-3">
                    <span aria-hidden className={cn("inline-block size-2.5 translate-y-px rounded-full", swatch[k.kind])} />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{k.label}</p>
                      <p className="text-caption text-muted-foreground">{k.hint}</p>
                    </div>
                    <span className="font-display text-heading tnum">{view.counts[k.kind]}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      </div>

      <Section title="Recent activity" description="The last five entries of this case's hash-chained audit log.">
        <div className="overflow-hidden rounded-lg border bg-card">
          {recent.length ? (
            <ul className="divide-y divide-hairline">
              {recent.map((e) => (
                <li key={e.id} className="grid grid-cols-[9rem_10rem_1fr_auto] items-center gap-4 px-6 py-3.5 text-body">
                  <span className="text-muted-foreground tnum">{format(new Date(e.ts), "d MMM, HH:mm")}</span>
                  <span className="truncate text-muted-foreground">{e.actor}</span>
                  <span className="min-w-0 truncate">{e.action} {e.filename && <span className="font-mono text-caption text-muted-foreground">{e.filename}</span>}</span>
                  <code className="font-mono text-caption text-muted-foreground">{e.event_hash.slice(0, 8)}</code>
                </li>
              ))}
            </ul>
          ) : <p className="p-6 text-muted-foreground">{data.loading ? "Loading…" : "No activity recorded yet."}</p>}
        </div>
      </Section>
    </div>
  )
}
