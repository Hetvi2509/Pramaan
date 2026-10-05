import { useMemo, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { InfoIcon } from "@phosphor-icons/react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PageHeader, Section } from "@/components/pramaan/page-header"
import { channelName, coverageView, formatMs, useCaseData } from "@/lib/case-data"
import { cn } from "@/lib/utils"

const tasks = [
  { value: "all", label: "All" },
  { value: "objects", label: "Objects" },
  { value: "motion", label: "Motion" },
  { value: "faces", label: "Faces" },
]

const kindLabel = { motion: "Motion", objects: "Object", faces: "Face lead" } as const
const clip = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`

export default function AnalyticsPage() {
  const { caseId = "" } = useParams()
  const data = useCaseData(caseId)
  const [task, setTask] = useState("all")

  const rows = useMemo(() => data.analysis.flatMap((run) => {
    const rec = data.recordings.find((r) => r.imageId === run.imageFileId && r.id === run.recordingId)
    const base = { run, rec }
    if (run.kind === "faces" || !run.data.appearances.length)
      return [{ ...base, key: `${run.id}-run`, cls: run.kind === "faces" ? "Face lead run" : `${kindLabel[run.kind]} run`, a: null as null | { start_s: number; end_s: number; confidence?: number } }]
    return run.data.appearances.map((a, i) => ({ ...base, key: `${run.id}-${i}`, cls: a.class, a }))
  }).filter((r) => task === "all" || r.run.kind === task), [data, task])

  const coverage = useMemo(() => coverageView(data), [data])
  const excluded = data.recordings.filter((r) => r.kind === "excluded")

  return (
    <div className="space-y-12">
      <PageHeader
        eyebrow="Analytics"
        title="What the footage shows"
        description="Detections on clips that passed validation. Each one says whether the footage was live or recovered."
      />

      <Alert>
        <InfoIcon />
        <AlertTitle>Faces are leads, not identification</AlertTitle>
        <AlertDescription>
          Face matches point an examiner at a frame worth watching. They are never presented as an identity.
        </AlertDescription>
      </Alert>

      <div className="space-y-5">
        <Tabs value={task} onValueChange={setTask}>
          <TabsList>
            {tasks.map((t) => (
              <TabsTrigger key={t.value} value={t.value}>{t.label}</TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <div className="overflow-hidden rounded-lg border bg-card">
          {!rows.length && (
            <p className="p-6 text-muted-foreground">
              {data.loading ? "Loading…" : data.analysis.length ? "No findings of this type." :
                <>No analysis has been run in this case. Recover a recording, then run <Link className="underline" to={`/cases/${caseId}/motion`}>Motion</Link> or <Link className="underline" to={`/cases/${caseId}/objects`}>Object detection</Link> on it, choosing the recovered clip.</>}
            </p>
          )}
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-6">Detection</TableHead>
                <TableHead>Channel</TableHead>
                <TableHead>Time</TableHead>
                <TableHead>Footage</TableHead>
                <TableHead className="pr-6 text-right">Confidence</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((d) => {
                const at = d.rec?.startMs != null && d.a ? formatMs(d.rec.startMs + d.a.start_s * 1000, "utc") : d.a ? `${clip(d.a.start_s)} into clip` : "Whole clip"
                return (
                  <TableRow key={d.key}>
                    <TableCell className="pl-6">
                      <span className="font-medium">{d.cls}</span>{" "}
                      <span className="block max-w-56 truncate font-mono text-caption text-muted-foreground" title={d.run.source}>{d.run.source}</span>
                    </TableCell>
                    <TableCell className="font-mono text-caption">{d.run.channel != null ? channelName(d.run.channel) : "Unknown"}</TableCell>
                    <TableCell className="tnum">{at}{d.a && d.a.end_s > d.a.start_s ? <span className="block text-caption text-muted-foreground">for {Math.max(1, Math.round(d.a.end_s - d.a.start_s))} s</span> : null}</TableCell>
                    <TableCell>
                      {d.rec ? <span className="inline-flex items-center gap-2 capitalize">
                        <span aria-hidden className={cn("inline-block size-2.5 rounded-full", d.rec.kind === "live" ? "bg-secondary" : d.rec.kind === "deleted" ? "bg-accent" : "border border-dashed border-foreground/40")} />
                        {d.rec.kind === "unknown" ? "not classed" : d.rec.kind}</span>
                        : <span className="text-muted-foreground">Uploaded file</span>}
                    </TableCell>
                    <TableCell className="pr-6 text-right tnum">{d.a?.confidence != null ? `${Math.round(d.a.confidence * 100)}%` : "—"}</TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      </div>

      <Section title="What was checked" description="Anything not analysed is listed here and in the report.">
        <Card>
          <CardContent className="divide-y divide-hairline">
            {coverage.map((c) => (
              <div key={c.key} className="grid items-center gap-x-6 gap-y-2 py-4 first:pt-0 last:pb-0 md:grid-cols-[12rem_1fr_16rem_3rem]">
                <span className="truncate font-mono text-caption" title={c.label}>{c.label}</span>
                <Progress value={c.pct} aria-label={`${c.label} coverage`} className="h-2" />
                <span className="text-caption text-muted-foreground tnum">{c.done} of {c.total} recording(s) analysed</span>
                <span className="text-right tnum">{c.pct}%</span>
              </div>
            ))}
            {!coverage.length && <p className="text-muted-foreground">{data.loading ? "Loading…" : "No recordings in this case yet."}</p>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2.5">Not analysed <Badge variant="warning" className="tnum">{excluded.length}</Badge></CardTitle>
            <CardDescription>
              {excluded.length
                ? `${excluded.length} recording(s) failed the quality gate (${excluded.slice(0, 4).map((r) => `${channelName(r.channel)} #${r.id}`).join(", ")}${excluded.length > 4 ? ", …" : ""}). Detections there would come from decode noise.`
                : "No recording has failed the quality gate."}
            </CardDescription>
          </CardHeader>
        </Card>
      </Section>
    </div>
  )
}
