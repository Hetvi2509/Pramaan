import { useMemo, useRef, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { PageHeader } from "@/components/pramaan/page-header"
import { kindOf, pairUp, sightings, useCaseData, type Sighting } from "@/lib/case-data"

// Categorical colour, not status colour: chart-4/chart-5 skip chart-2/chart-3 (== --secondary/--accent),
// which already mean "live footage" / "deleted footage" elsewhere.
const colorOf = (cls: string) => cls === "person" ? "var(--chart-4)" : kindOf(cls) === "vehicle" ? "var(--chart-5)" : cls === "motion" ? "var(--chart-1)" : "var(--muted-foreground)"

const VW = 1000, PAD_L = 110, PAD_R = 40, LANE_TOP = 36, LANE_GAP = 56
const pad2 = (n: number) => String(n).padStart(2, "0")
const stamp = (ms: number) => { const d = new Date(ms); return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}` }
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)

type Ev = Sighting

export default function CorrelationPage() {
  const { caseId = "" } = useParams()
  const data = useCaseData(caseId)
  const [gap, setGap] = useState(120)
  const [cls, setCls] = useState("all")
  const [sel, setSel] = useState<string | null>(null)
  const [hover, setHover] = useState<{ e: Ev; x: number; y: number } | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  const { events, skipped } = useMemo(() => sightings(data), [data])

  const lanes = useMemo(() => [...new Set(events.map((e) => e.lane))].sort(), [events])
  const labelOf = (lane: string) => events.find((e) => e.lane === lane)?.label ?? lane
  const kinds = useMemo(() => [...new Set(events.map((e) => e.kind))].sort(), [events])
  const t0 = events.length ? Math.min(...events.map((e) => e.t)) - 30_000 : 0
  const t1 = events.length ? Math.max(Math.max(...events.map((e) => e.t)) + 30_000, t0 + 60_000) : 1
  const VH = LANE_TOP + Math.max(lanes.length - 1, 0) * LANE_GAP + 70
  const AXIS_Y = LANE_TOP + Math.max(lanes.length - 1, 0) * LANE_GAP + 44
  const ticks = useMemo(() => Array.from({ length: 6 }, (_, i) => t0 + ((t1 - t0) * i) / 5), [t0, t1])

  const pairs = useMemo(() => pairUp(events, gap, cls), [events, gap, cls])

  const X = (t: number) => PAD_L + ((t - t0) / (t1 - t0)) * (VW - PAD_L - PAD_R)
  const Y = (lane: string) => LANE_TOP + lanes.indexOf(lane) * LANE_GAP
  const chosen = pairs.find((p) => p.id === sel)
  const sameDay = events.length > 0 && dayOf(t0) === dayOf(t1)

  function point(e: Ev) {
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    setHover({ e, x: (X(e.t) / VW) * rect.width, y: (Y(e.lane) / VH) * rect.height })
  }

  return (
    <div className="space-y-10">
      <PageHeader
        eyebrow="Case"
        title="Cross-camera correlation"
        description="The same kind of object seen by two cameras a short time apart. Each pair is a lead to check by eye, not a confirmed match."
      />
      <Alert>
        <AlertDescription>
          Each sighting is linked to the nearest later sighting of the same kind on each other camera, from the kind of object and the time only. Nothing compares appearance, so a busy scene will produce false pairs. Each camera's recorder keeps its own clock, and the gap shown is not corrected for any difference between them.
        </AlertDescription>
      </Alert>

      {data.error && <p role="alert" className="text-destructive">{data.error}</p>}

      <div className="flex flex-wrap items-end justify-between gap-6">
        <div className="space-y-3">
          <p className="text-body font-medium">Largest gap between sightings: <span className="tnum">{gap} s</span></p>
          <Slider className="w-72" min={30} max={300} step={10} value={[gap]} onValueChange={([v]) => setGap(v)} aria-label="Largest gap in seconds" />
        </div>
        <Select value={cls} onValueChange={setCls}>
          <SelectTrigger className="w-44" aria-label="Object class"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All classes</SelectItem>
            {kinds.map((k) => <SelectItem key={k} value={k} className="capitalize">{k}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Events on one clock</CardTitle>
          <CardDescription>
            {events.length
              ? `${events.length} sighting(s) on ${lanes.length} camera(s), UTC${sameDay ? `, ${dayOf(t0)}` : ""}. Select a pair to link its two sightings.`
              : data.loading ? "Loading…" : "Nothing to place yet."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!events.length && !data.loading && (
            <p className="text-muted-foreground">
              {skipped
                ? `${skipped} finding(s) came from files with no known channel or recording time, so they cannot be placed against other cameras. `
                : "No analysis has been run in this case. "}
              Recover recordings on at least two channels, then run <Link className="underline" to={`/cases/${caseId}/objects`}>Object detection</Link> or{" "}
              <Link className="underline" to={`/cases/${caseId}/motion`}>Motion</Link> on each, choosing the recovered clip.
            </p>
          )}
          {!!events.length && (
            <>
              <div className="relative">
                <svg ref={svgRef} viewBox={`0 0 ${VW} ${VH}`} className="w-full" role="img" aria-label="Events per camera on a shared timeline">
                  {ticks.map((t) => <line key={t} x1={X(t)} x2={X(t)} y1={LANE_TOP - 16} y2={AXIS_Y - 16} stroke="var(--hairline)" strokeWidth="1" />)}
                  {lanes.map((l) => (
                    <g key={l}>
                      <line x1={PAD_L} x2={VW - PAD_R} y1={Y(l)} y2={Y(l)} stroke="var(--hairline)" strokeWidth="1" />
                      <text x="0" y={Y(l) + 4} fill="var(--foreground)" fontSize="12" fontFamily="ui-monospace, Consolas, monospace">{labelOf(l).slice(0, 16)}</text>
                    </g>
                  ))}
                  <line x1={PAD_L} x2={VW - PAD_R} y1={AXIS_Y - 16} y2={AXIS_Y - 16} stroke="var(--hairline)" strokeWidth="1" />
                  {ticks.map((t) => <text key={t} x={X(t)} y={AXIS_Y} textAnchor="middle" fill="var(--muted-foreground)" fontSize="11" className="tnum">{stamp(t)}</text>)}
                  {pairs.map((p) => (
                    <line key={p.id} x1={X(p.a.t)} y1={Y(p.a.lane)} x2={X(p.b.t)} y2={Y(p.b.lane)} strokeWidth={sel === p.id ? 2.5 : 1.5} strokeLinecap="round"
                      stroke={sel === p.id ? "var(--primary)" : "var(--muted-foreground)"} strokeOpacity={sel === p.id ? 1 : 0.35} />
                  ))}
                  {events.map((e) => {
                    const on = chosen && (chosen.a.id === e.id || chosen.b.id === e.id)
                    const isHover = hover?.e.id === e.id
                    return (
                      <g key={e.id}>
                        <circle cx={X(e.t)} cy={Y(e.lane)} r={on || isHover ? 8 : 6} fill={colorOf(e.cls)} stroke={on ? "var(--primary)" : "var(--card)"} strokeWidth="2.5" />
                        {/* Larger, invisible hit target: an 8px mark is a pinpoint, give it room. */}
                        <circle cx={X(e.t)} cy={Y(e.lane)} r="14" fill="transparent" tabIndex={0} role="img" aria-label={`${e.cls}, ${e.label}, ${stamp(e.t)}`}
                          className="cursor-pointer outline-none" onMouseEnter={() => point(e)} onMouseLeave={() => setHover((h) => (h?.e.id === e.id ? null : h))}
                          onFocus={() => point(e)} onBlur={() => setHover((h) => (h?.e.id === e.id ? null : h))} />
                      </g>
                    )
                  })}
                </svg>
                {hover && (
                  <div className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-[calc(100%+12px)] rounded-md border bg-popover px-3 py-2 shadow-md" style={{ left: hover.x, top: hover.y }}>
                    <p className="tnum text-body font-medium text-popover-foreground">{stamp(hover.e.t)} UTC</p>
                    <p className="text-caption text-muted-foreground"><span className="capitalize">{hover.e.cls}</span> · {hover.e.label}</p>
                    <p className="max-w-56 truncate text-caption text-muted-foreground">{hover.e.source}</p>
                  </div>
                )}
              </div>
              <div className="mt-4 flex flex-wrap gap-6 text-caption text-muted-foreground">
                {[...new Set(events.map((e) => e.cls))].map((c) => (
                  <span key={c} className="inline-flex items-center gap-2 capitalize"><i className="size-2.5 rounded-full" style={{ background: colorOf(c) }} /> {c}</span>
                ))}
                {skipped > 0 && <span className="ml-auto">{skipped} finding(s) from clips with no known time are not shown.</span>}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {!!events.length && (
        <div className="space-y-5">
          <div className="overflow-hidden rounded-lg border bg-card">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-6">Object</TableHead>
                  <TableHead>First seen (UTC)</TableHead>
                  <TableHead>Then seen (UTC)</TableHead>
                  <TableHead className="text-right">Gap</TableHead>
                  <TableHead className="pr-6 text-right">Closeness</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pairs.length ? pairs.map((p) => (
                  <TableRow key={p.id} tabIndex={0} data-state={sel === p.id ? "selected" : undefined} onClick={() => setSel(sel === p.id ? null : p.id)}
                    onKeyDown={(e) => e.key === "Enter" && setSel(sel === p.id ? null : p.id)} className="cursor-pointer outline-none focus-visible:bg-primary-soft">
                    <TableCell className="pl-6 font-medium capitalize">{p.a.kind}</TableCell>
                    <TableCell className="tnum">{p.a.label}, {stamp(p.a.t)}</TableCell>
                    <TableCell className="tnum">{p.b.label}, {stamp(p.b.t)}</TableCell>
                    <TableCell className="text-right tnum">{Math.round(p.dt)} s</TableCell>
                    <TableCell className="pr-6 text-right"><Badge variant={p.dt <= 60 ? "success" : "warning"}>{p.dt <= 60 ? "Close" : "Further apart"}</Badge></TableCell>
                  </TableRow>
                )) : (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={5} className="py-12 text-center text-muted-foreground">No pairs within {gap} s. Raise the gap to see more.</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <p className="text-caption text-muted-foreground">Close means the sightings are under a minute apart. Neither label means the same object was seen; confirm by watching both clips.</p>
        </div>
      )}
    </div>
  )
}
