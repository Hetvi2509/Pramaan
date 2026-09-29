import { useMemo, useRef, useState } from "react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { PageHeader } from "@/components/pramaan/page-header"

// Minutes from 13 Sep 23:50 IST. Window is 110 minutes.
const W = 110
const lanes = ["CH 01", "CH 03", "CH 07", "CH 11"]
const names: Record<string, string> = { "CH 01": "Entrance", "CH 03": "Counter", "CH 07": "Back door", "CH 11": "Parking" }
const clockOf = (m: number) => {
  const s = Math.round(m * 60) + 23 * 3600 + 50 * 60
  const p = (n: number) => String(n).padStart(2, "0")
  return `${p(Math.floor(s / 3600) % 24)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`
}
const at = (h: number, m: number, s: number) => (h * 3600 + m * 60 + s - (23 * 3600 + 50 * 60) + 86400) % 86400 / 60

const events = [
  { id: "a", cam: "CH 11", cls: "vehicle", t: at(23, 58, 31) },
  { id: "b", cam: "CH 01", cls: "vehicle", t: at(23, 59, 12) },
  { id: "c", cam: "CH 01", cls: "person", t: at(25, 21, 55) },
  { id: "d", cam: "CH 03", cls: "person", t: at(25, 23, 8) },
  { id: "e", cam: "CH 07", cls: "person", t: at(25, 24, 41) },
]
const sigma = 1.4 // seconds, from the timeline's clock model
const combined = (sigma * Math.SQRT2).toFixed(1) // two independent clocks

// Categorical colour, not status colour: chart-4/chart-5 deliberately skip chart-2/chart-3
// (== --secondary/--accent), which already mean "live footage" / "deleted footage" elsewhere.
const classColor: Record<string, string> = { person: "var(--chart-4)", vehicle: "var(--chart-5)" }
const ticks = Array.from({ length: Math.floor(W / 20) + 1 }, (_, i) => i * 20)
const VW = 1000
const VH = 260
const PAD_L = 76
const PAD_R = 40
const LANE_TOP = 36
const LANE_GAP = 56
const AXIS_Y = LANE_TOP + (lanes.length - 1) * LANE_GAP + 44

type Ev = (typeof events)[number]

export default function CorrelationPage() {
  const [gap, setGap] = useState(120)
  const [cls, setCls] = useState("all")
  const [sel, setSel] = useState<string | null>(null)
  const [hover, setHover] = useState<{ e: Ev; x: number; y: number } | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  const pairs = useMemo(() => {
    const out: { id: string; a: Ev; b: Ev; dt: number }[] = []
    for (const a of events)
      for (const b of events)
        if (a.cam !== b.cam && a.cls === b.cls && a.t < b.t) {
          const dt = (b.t - a.t) * 60
          if (dt <= gap && (cls === "all" || a.cls === cls)) out.push({ id: a.id + b.id, a, b, dt })
        }
    return out.sort((x, y) => x.a.t - y.a.t)
  }, [gap, cls])

  const X = (m: number) => PAD_L + (m / W) * (VW - PAD_L - PAD_R)
  const Y = (cam: string) => LANE_TOP + lanes.indexOf(cam) * LANE_GAP
  const chosen = pairs.find((p) => p.id === sel)

  function point(e: Ev) {
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    setHover({ e, x: (X(e.t) / VW) * rect.width, y: (Y(e.cam) / VH) * rect.height })
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
          Pairs are found from object class and time only. Nothing compares appearance, so a busy scene will produce false pairs. Every time is shown with the clock uncertainty (±{sigma} s).
        </AlertDescription>
      </Alert>

      <div className="flex flex-wrap items-end justify-between gap-6">
        <div className="space-y-3">
          <p className="text-body font-medium">
            Largest gap between sightings: <span className="tnum">{gap} s</span>
          </p>
          <Slider className="w-72" min={30} max={300} step={10} value={[gap]} onValueChange={([v]) => setGap(v)} aria-label="Largest gap in seconds" />
        </div>
        <Select value={cls} onValueChange={setCls}>
          <SelectTrigger className="w-44" aria-label="Object class">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All classes</SelectItem>
            <SelectItem value="person">Person</SelectItem>
            <SelectItem value="vehicle">Vehicle</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Events on one clock</CardTitle>
          <CardDescription>13 Sep 23:50 to 14 Sep 01:40 IST. Select a pair to link its two sightings.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="relative">
            <svg ref={svgRef} viewBox={`0 0 ${VW} ${VH}`} className="w-full" role="img" aria-label="Events per camera on a shared timeline">
              {ticks.map((m) => (
                <line key={m} x1={X(m)} x2={X(m)} y1={LANE_TOP - 16} y2={AXIS_Y - 16} stroke="var(--hairline)" strokeWidth="1" />
              ))}
              {lanes.map((l) => (
                <g key={l}>
                  <line x1={PAD_L} x2={VW - PAD_R} y1={Y(l)} y2={Y(l)} stroke="var(--hairline)" strokeWidth="1" />
                  <text x="0" y={Y(l) + 4} fill="var(--foreground)" fontSize="12" fontFamily="ui-monospace, Consolas, monospace">{l}</text>
                </g>
              ))}
              <line x1={PAD_L} x2={VW - PAD_R} y1={AXIS_Y - 16} y2={AXIS_Y - 16} stroke="var(--hairline)" strokeWidth="1" />
              {ticks.map((m) => (
                <text key={m} x={X(m)} y={AXIS_Y} textAnchor="middle" fill="var(--muted-foreground)" fontSize="11" className="tnum">{clockOf(m).slice(0, 5)}</text>
              ))}
              {pairs.map((p) => (
                <line
                  key={p.id}
                  x1={X(p.a.t)}
                  y1={Y(p.a.cam)}
                  x2={X(p.b.t)}
                  y2={Y(p.b.cam)}
                  strokeWidth={sel === p.id ? 2.5 : 1.5}
                  strokeLinecap="round"
                  stroke={sel === p.id ? "var(--primary)" : "var(--muted-foreground)"}
                  strokeOpacity={sel === p.id ? 1 : 0.35}
                />
              ))}
              {events.map((e) => {
                const on = chosen && (chosen.a.id === e.id || chosen.b.id === e.id)
                const isHover = hover?.e.id === e.id
                return (
                  <g key={e.id}>
                    <circle
                      cx={X(e.t)}
                      cy={Y(e.cam)}
                      r={on || isHover ? 8 : 6}
                      fill={classColor[e.cls]}
                      stroke={on ? "var(--primary)" : "var(--card)"}
                      strokeWidth="2.5"
                    />
                    {/* Larger, invisible hit target: an 8px mark is a pinpoint, give it room. */}
                    <circle
                      cx={X(e.t)}
                      cy={Y(e.cam)}
                      r="14"
                      fill="transparent"
                      tabIndex={0}
                      role="img"
                      aria-label={`${e.cls}, ${e.cam}, ${clockOf(e.t)}`}
                      className="cursor-pointer outline-none"
                      onMouseEnter={() => point(e)}
                      onMouseLeave={() => setHover((h) => (h?.e.id === e.id ? null : h))}
                      onFocus={() => point(e)}
                      onBlur={() => setHover((h) => (h?.e.id === e.id ? null : h))}
                    />
                  </g>
                )
              })}
            </svg>
            {hover && (
              <div
                className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-[calc(100%+12px)] rounded-md border bg-popover px-3 py-2 shadow-md"
                style={{ left: hover.x, top: hover.y }}
              >
                <p className="tnum text-body font-medium text-popover-foreground">{clockOf(hover.e.t)}</p>
                <p className="text-caption text-muted-foreground">
                  <span className="capitalize">{hover.e.cls}</span> · {hover.e.cam} · {names[hover.e.cam]}
                </p>
              </div>
            )}
          </div>
          <div className="mt-4 flex gap-6 text-caption text-muted-foreground">
            <span className="inline-flex items-center gap-2"><i className="size-2.5 rounded-full" style={{ background: classColor.person }} /> person</span>
            <span className="inline-flex items-center gap-2"><i className="size-2.5 rounded-full" style={{ background: classColor.vehicle }} /> vehicle</span>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-5">
        <div className="overflow-hidden rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-6">Object</TableHead>
                <TableHead>First seen</TableHead>
                <TableHead>Then seen</TableHead>
                <TableHead className="text-right">Gap</TableHead>
                <TableHead className="pr-6 text-right">Strength</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pairs.length ? (
                pairs.map((p) => (
                  <TableRow
                    key={p.id}
                    tabIndex={0}
                    data-state={sel === p.id ? "selected" : undefined}
                    onClick={() => setSel(sel === p.id ? null : p.id)}
                    onKeyDown={(e) => e.key === "Enter" && setSel(sel === p.id ? null : p.id)}
                    className="cursor-pointer outline-none focus-visible:bg-primary-soft"
                  >
                    <TableCell className="pl-6 font-medium capitalize">{p.a.cls}</TableCell>
                    <TableCell className="tnum">{p.a.cam} · {names[p.a.cam]}, {clockOf(p.a.t)}</TableCell>
                    <TableCell className="tnum">{p.b.cam} · {names[p.b.cam]}, {clockOf(p.b.t)}</TableCell>
                    <TableCell className="text-right tnum">{Math.round(p.dt)} s ±{combined}</TableCell>
                    <TableCell className="pr-6 text-right">
                      <Badge variant={p.dt <= 60 ? "success" : "warning"}>{p.dt <= 60 ? "Likely" : "Possible"}</Badge>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={5} className="py-12 text-center text-muted-foreground">
                    No pairs within {gap} s. Raise the gap to see more.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <p className="text-caption text-muted-foreground">Likely means the sightings are under a minute apart. Neither label means the same object was seen; confirm by watching both clips.</p>
      </div>
    </div>
  )
}
