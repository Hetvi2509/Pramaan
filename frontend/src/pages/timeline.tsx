import { useMemo, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { CheckCircleIcon, MinusCircleIcon } from "@phosphor-icons/react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { PageHeader, Section } from "@/components/pramaan/page-header"
import { footageSwatch } from "@/components/pramaan/status"
import { channelName, clockSources, formatMs, laneKey, laneLabel, useCaseData, type Kind } from "@/lib/case-data"
import { cn } from "@/lib/utils"

const swatch: Record<Kind, string> = { ...footageSwatch, unknown: "border border-dashed border-foreground/40 bg-transparent" }
const legend: { kind: Kind; label: string }[] = [
  { kind: "live", label: "Live" },
  { kind: "deleted", label: "Deleted, recoverable" },
  { kind: "excluded", label: "Failed the quality gate" },
  { kind: "unknown", label: "Live or deleted not known" },
]

const MIN = 60_000
// Up to a year per tick, so a case holding evidence from different years still gets a readable axis.
const STEPS = [10, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080, 43200, 129600, 525600].map((m) => m * MIN)

export default function TimelinePage() {
  const { caseId = "" } = useParams()
  const data = useCaseData(caseId)
  const [zone, setZone] = useState<"utc" | "ist">("utc")
  const [channel, setChannel] = useState("all")
  const offset = zone === "ist" ? 330 * MIN : 0

  const placed = useMemo(() => data.recordings.filter((r) => r.startMs !== null), [data.recordings])
  const unplaced = data.recordings.length - placed.length
  const channels = useMemo(() => [...new Set(placed.map((r) => r.channel))].sort((a, b) => (a ?? 1e9) - (b ?? 1e9)), [placed])

  const axis = useMemo(() => {
    if (!placed.length) return null
    const lo = Math.min(...placed.map((r) => r.startMs!))
    const hi = Math.max(...placed.map((r) => r.endMs ?? r.startMs!))
    const span = Math.max(hi - lo, 30 * MIN)
    const step = STEPS.find((s) => span / s <= 8) ?? STEPS[STEPS.length - 1]
    const t0 = Math.floor((lo + offset) / step) * step - offset
    const t1 = Math.max(Math.ceil((hi + offset) / step) * step - offset, t0 + step)
    const ticks: number[] = []
    for (let t = t0; t <= t1; t += step) ticks.push(t)
    return { t0, t1, ticks, step, long: t1 - t0 > 24 * 60 * MIN }
  }, [placed, offset])

  const pct = (ms: number) => axis ? ((ms - axis.t0) / (axis.t1 - axis.t0)) * 100 : 0
  const tick = (ms: number) => {
    const d = new Date(ms + offset).toISOString()
    if (axis && axis.step >= 1440 * MIN) return d.slice(0, 10)
    return axis?.long ? `${d.slice(8, 10)}/${d.slice(5, 7)} ${d.slice(11, 16)}` : d.slice(11, 16)
  }

  // The interval between the newest deleted footage and the oldest live footage, when deleted comes first.
  const gap = useMemo(() => {
    const deleted = placed.filter((r) => r.kind === "deleted"), live = placed.filter((r) => r.kind === "live")
    if (!deleted.length || !live.length) return null
    const from = Math.max(...deleted.map((r) => r.endMs ?? r.startMs!)), to = Math.min(...live.map((r) => r.startMs!))
    return to > from ? { from, to } : null
  }, [placed])

  const manyImages = new Set(placed.map((r) => r.imageId)).size > 1
  const laneList = useMemo(() => {
    const seen = new Map<string, { key: string; ch: number | null; imageId: number; label: string }>()
    for (const r of placed) {
      const key = laneKey(r.imageId, r.channel)
      if (!seen.has(key)) seen.set(key, { key, ch: r.channel, imageId: r.imageId, label: laneLabel(r.channel, r.imageName, manyImages) })
    }
    return [...seen.values()].sort((a, b) => a.imageId - b.imageId || (a.ch ?? 1e9) - (b.ch ?? 1e9))
  }, [placed, manyImages])
  const lanes = laneList.filter((l) => channel === "all" || String(l.ch) === channel)
  const witnesses = clockSources(data, zone)

  return (
    <div className="space-y-12">
      <PageHeader
        eyebrow="Timeline"
        title="What was recorded, and when"
        description="Built from the recordings your parsed evidence lists. Times are the recorder's own clock, moved to UTC with the time-zone and drift you set on the Recovery page."
        actions={
          <ToggleGroup type="single" value={zone} onValueChange={(v) => v && setZone(v as "utc" | "ist")} variant="outline" aria-label="Time display">
            <ToggleGroupItem value="utc" className="px-3.5">UTC</ToggleGroupItem>
            <ToggleGroupItem value="ist" className="px-3.5">IST</ToggleGroupItem>
          </ToggleGroup>
        }
      />

      {data.error && <p role="alert" className="text-destructive">{data.error}</p>}

      <Card>
        <CardHeader>
          <CardTitle>Channels</CardTitle>
          <CardDescription>
            {axis
              ? `${formatMs(axis.t0, zone)} to ${formatMs(axis.t1, zone)}. ${placed.length} recording(s) on ${channels.length} channel(s).`
              : data.loading ? "Loading the case's recordings…" : "Nothing to place yet."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {!axis && !data.loading && (
            <p className="text-muted-foreground">
              {data.parsed.length
                ? "The parsed evidence lists no recording with a readable recorder time, so there is nothing to draw."
                : <>No evidence has been parsed in this case. <Link className="underline" to={`/cases/${caseId}/parsing`}>Parse evidence</Link> first.</>}
            </p>
          )}

          {axis && (
            <div className="grid grid-cols-[7rem_1fr] gap-x-2">
              <div className="col-start-2 h-3" />
              <div className="divide-y-0">
                {lanes.map((l) => (
                  <div key={l.key} className="flex h-11 flex-col justify-center">
                    <p className="truncate font-mono text-caption leading-tight" title={l.label}>{l.label}</p>
                  </div>
                ))}
              </div>
              <div className="relative">
                {axis.ticks.map((t) => <span key={t} aria-hidden className="absolute inset-y-0 w-px bg-hairline" style={{ left: `${pct(t)}%` }} />)}
                {gap && (
                  <div aria-hidden className="absolute inset-y-0 rounded-sm bg-[repeating-linear-gradient(135deg,var(--hairline)_0_1px,transparent_1px_6px)] ring-1 ring-foreground/20 ring-inset"
                    style={{ left: `${pct(gap.from)}%`, width: `${pct(gap.to) - pct(gap.from)}%` }} />
                )}
                {lanes.map((l) => (
                  <div key={l.key} className="relative flex h-11 items-center">
                    <div className="relative h-3.5 w-full">
                      {placed.filter((r) => laneKey(r.imageId, r.channel) === l.key).map((r) => {
                        const end = r.endMs ?? r.startMs!
                        return (
                          <Tooltip key={`${r.imageId}-${r.id}`}>
                            <TooltipTrigger asChild>
                              <span tabIndex={0}
                                className={cn("absolute inset-y-0 min-w-1 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2", swatch[r.kind])}
                                style={{ left: `${pct(r.startMs!)}%`, width: `${Math.max(pct(end) - pct(r.startMs!), 0.4)}%` }} />
                            </TooltipTrigger>
                            <TooltipContent>
                              <span className="block capitalize">{r.kind === "unknown" ? "live or deleted not known" : r.kind}</span>
                              <span className="tnum">{formatMs(r.startMs!, zone)}{r.endMs ? ` to ${formatMs(r.endMs, zone)}` : " (end not recorded)"}</span>
                              <span className="block text-caption text-muted-foreground">{r.imageName}</span>
                            </TooltipContent>
                          </Tooltip>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
              <div />
              <div className="relative mt-2 h-5 text-caption text-muted-foreground tnum">
                {axis.ticks.map((t, i) => (
                  <span key={t} className={cn("absolute -translate-x-1/2", i === 0 && "translate-x-0", i === axis.ticks.length - 1 && "-translate-x-full")} style={{ left: `${pct(t)}%` }}>{tick(t)}</span>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-hairline pt-5 text-caption text-muted-foreground">
            {legend.map(({ kind, label }) => (
              <span key={kind} className="inline-flex items-center gap-2">
                <span aria-hidden className={cn("inline-block size-2.5 rounded-full", swatch[kind])} /> {label}
              </span>
            ))}
            {gap && (
              <span className="ml-auto text-foreground">
                No footage between deleted and live: <span className="tnum">{formatMs(gap.from, zone)} to {formatMs(gap.to, zone)}</span>
              </span>
            )}
          </div>
          {(unplaced > 0 || data.emptyEntries > 0) && (
            <p className="text-caption text-muted-foreground">
              {unplaced > 0 && `${unplaced} recording(s) have no readable recorder time and are not drawn. `}
              {data.emptyEntries > 0 && `${data.emptyEntries} index entr${data.emptyEntries === 1 ? "y points" : "ies point"} at no video.`}
            </p>
          )}
        </CardContent>
      </Card>

      <Section
        title="Clock sources"
        description="Which clocks this case holds evidence from. Comparing them for disagreement is not automated yet, so none is marked consistent."
        action={
          <Select value={channel} onValueChange={setChannel}>
            <SelectTrigger size="sm" className="w-44" aria-label="Channel"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All channels</SelectItem>
              {channels.map((c) => <SelectItem key={String(c)} value={String(c)}>{channelName(c)}</SelectItem>)}
            </SelectContent>
          </Select>
        }
      >
        <div className="overflow-hidden rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-14 pl-6">ID</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Independent of recorder</TableHead>
                <TableHead>What the case holds</TableHead>
                <TableHead className="pr-6 text-right">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {witnesses.map((w) => (
                <TableRow key={w.id}>
                  <TableCell className="pl-6 font-mono text-caption text-muted-foreground">{w.id}</TableCell>
                  <TableCell>
                    <div className="space-y-1"><p className="font-medium">{w.name}</p><p className="text-caption text-muted-foreground">{w.source}</p></div>
                  </TableCell>
                  <TableCell>{w.independent}</TableCell>
                  <TableCell className="tnum">{w.detail}</TableCell>
                  <TableCell className="pr-6 text-right">
                    {w.available
                      ? <Badge variant="neutral"><CheckCircleIcon weight="fill" /> Available</Badge>
                      : <Badge variant="warning"><MinusCircleIcon weight="fill" /> Not available</Badge>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Section>
    </div>
  )
}
