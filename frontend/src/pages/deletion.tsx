import { useMemo } from "react"
import { Link, useParams } from "react-router-dom"
import { ArrowRightIcon, WarningIcon } from "@phosphor-icons/react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { PageHeader, Section } from "@/components/pramaan/page-header"
import { deletionView, formatMs, useCaseData } from "@/lib/case-data"

const minutes = (ms: number) => ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)} h` : `${Math.round(ms / 60_000)} min`

export default function DeletionPage() {
  const { caseId = "" } = useParams()
  const data = useCaseData(caseId)

  const view = useMemo(() => deletionView(data), [data])
  const zone = "utc" as const
  const logsParsed = view.logsParsed
  const noEvidence = !data.loading && !data.parsed.length
  const evidence = view.observations

  return (
    <div className="space-y-12">
      <PageHeader
        eyebrow="Deletion"
        title="How the footage went missing"
        description="What the disk shows about deleted footage, and where the recorder's logs do or do not cover a gap in the video."
      />

      {data.error && <p role="alert" className="text-destructive">{data.error}</p>}
      {noEvidence && (
        <p className="text-muted-foreground">No evidence has been parsed in this case. <Link className="underline" to={`/cases/${caseId}/parsing`}>Parse evidence</Link> first.</p>
      )}

      {!noEvidence && (
        <Card>
          <CardContent className="grid gap-10 md:grid-cols-3">
            <div className="space-y-2">
              <p className="text-eyebrow font-medium tracking-(--text-eyebrow--letter-spacing) text-muted-foreground uppercase">Footage found</p>
              <p className="font-display text-display tnum">{data.loading ? "…" : `${view.deleted.length} deleted`}</p>
              <p className="text-caption text-muted-foreground tnum">{view.live.length} live, {view.unknown.length} not classed, across {data.parsed.length} evidence item(s).</p>
            </div>
            <div className="space-y-2">
              <p className="text-eyebrow font-medium tracking-(--text-eyebrow--letter-spacing) text-muted-foreground uppercase">Deleted footage covers</p>
              <p className="font-display text-heading tnum">{view.deletedSpan ? `${formatMs(view.deletedSpan.from, zone)} to ${formatMs(view.deletedSpan.to, zone)}` : "No timed deleted footage"}</p>
              <p className="text-caption text-muted-foreground">Recorder clock moved to UTC with this case's time settings.</p>
            </div>
            <div className="space-y-2">
              <p className="text-eyebrow font-medium tracking-(--text-eyebrow--letter-spacing) text-muted-foreground uppercase">Cause</p>
              <Badge variant="neutral" className="text-body">Not determined</Badge>
              <p className="text-caption text-muted-foreground">Pramaan lists what the disk holds. It does not decide whether footage was formatted, expired or overwritten.</p>
            </div>
          </CardContent>
        </Card>
      )}

      {!noEvidence && (
        <Section title="What the disk shows" description="Each observation, and what it may mean. These are readings of the evidence, not a verdict.">
          <Card>
            <CardContent>
              {evidence.length ? (
                <ul className="divide-y divide-hairline">
                  {evidence.map((e) => (
                    <li key={e.obs} className="grid items-start gap-3 py-4 first:pt-0 last:pb-0 md:grid-cols-[1fr_auto_16rem] md:gap-6">
                      <p>{e.obs}</p>
                      <ArrowRightIcon aria-hidden className="mt-1 hidden size-4 text-muted-foreground md:block" />
                      <p className="text-muted-foreground">{e.infer}</p>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-muted-foreground">{data.loading ? "Loading…" : "No deleted footage was found in this case's parsed evidence."}</p>}
            </CardContent>
          </Card>
        </Section>
      )}

      {!noEvidence && (
        <Section title="Gaps against the recorder's logs" description="Each stretch with no recording on a channel, and the log entries that fall inside it. A log entry in a gap is a lead to read, not an explanation.">
          {!logsParsed && !data.loading && (
            <p className="text-caption text-muted-foreground">No system log was parsed for this evidence, so gaps cannot be checked against logs. Only Hikvision disks have a log parser today.</p>
          )}
          <div className="overflow-hidden rounded-lg border bg-card">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-6">Gap</TableHead>
                  <TableHead>Between (UTC)</TableHead>
                  <TableHead>Log entries inside</TableHead>
                  <TableHead className="pr-6 text-right">Result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {view.gaps.slice(0, 50).map((g) => (
                  <TableRow key={`${g.key}-${g.from}`}>
                    <TableCell className="max-w-xs pl-6 whitespace-normal">{g.label}: nothing for {minutes(g.to - g.from)}</TableCell>
                    <TableCell className="tnum">{formatMs(g.from, zone)} to {formatMs(g.to, zone)}</TableCell>
                    <TableCell className="max-w-xs whitespace-normal text-muted-foreground">
                      {!logsParsed ? "No log to compare" : g.logs.length ? [...new Set(g.logs.map((l) => l.type))].join("; ") : "None"}
                    </TableCell>
                    <TableCell className="pr-6 text-right">
                      {!logsParsed ? <Badge variant="neutral">Not checked</Badge>
                        : g.logs.length ? <Badge variant="neutral">{g.logs.length} log entr{g.logs.length === 1 ? "y" : "ies"}</Badge>
                        : <Badge variant="warning"><WarningIcon weight="fill" /> No log entry</Badge>}
                    </TableCell>
                  </TableRow>
                ))}
                {!view.gaps.length && (
                  <TableRow><TableCell colSpan={4} className="pl-6 text-muted-foreground">
                    {data.loading ? "Loading…" : "No channel has a gap longer than two minutes between its recordings."}
                  </TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          {view.gaps.length > 50 && <p className="text-caption text-muted-foreground">Showing the 50 longest of {view.gaps.length} gaps.</p>}
        </Section>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Limits of this analysis</CardTitle>
          <CardDescription>
            Solid-state recorders can erase deleted data on their own (TRIM, wear levelling). An image does not say whether the source drive was solid-state, so missing footage is not proof it was never recorded.
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  )
}
