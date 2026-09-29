import { ArrowRightIcon, WarningIcon } from "@phosphor-icons/react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { PageHeader, Section } from "@/components/pramaan/page-header"
import { deletion } from "@/lib/mock"

const sevLabel = { danger: "Conflict", warning: "Check", neutral: "Consistent" } as const

export default function DeletionPage() {
  return (
    <div className="space-y-12">
      <PageHeader
        eyebrow="Deletion"
        title="How the footage went missing"
        description="The type of deletion, when it happened, and every place the recorder's logs and its video disagree."
      />

      <Card>
        <CardContent className="grid gap-10 md:grid-cols-[1fr_1fr_1fr]">
          <div className="space-y-2">
            <p className="text-eyebrow font-medium tracking-(--text-eyebrow--letter-spacing) text-muted-foreground uppercase">Type</p>
            <p className="font-display text-display">{deletion.type}</p>
          </div>
          <div className="space-y-2">
            <p className="text-eyebrow font-medium tracking-(--text-eyebrow--letter-spacing) text-muted-foreground uppercase">Format window</p>
            <p className="font-display text-heading tnum">{deletion.window}</p>
            <p className="text-caption text-muted-foreground">Between the last old frame and the first new one. Uncertainty <span className="tnum">{deletion.sigma}</span>.</p>
          </div>
          <div className="space-y-2">
            <p className="text-eyebrow font-medium tracking-(--text-eyebrow--letter-spacing) text-muted-foreground uppercase">Confidence</p>
            <Badge variant="success" className="text-body">{deletion.confidence}</Badge>
            <p className="text-caption text-muted-foreground">Thresholds calibrated on controlled disks, not assumed.</p>
          </div>
        </CardContent>
      </Card>

      <Section title="What supports this" description="Each observation on the disk, and what it implies.">
        <Card>
          <CardContent>
            <ul className="divide-y divide-hairline">
              {deletion.evidence.map((e) => (
                <li key={e.obs} className="grid items-start gap-3 py-4 first:pt-0 last:pb-0 md:grid-cols-[1fr_auto_16rem] md:gap-6">
                  <p>{e.obs}</p>
                  <ArrowRightIcon aria-hidden className="mt-1 hidden size-4 text-muted-foreground md:block" />
                  <p className="text-muted-foreground">{e.infer}</p>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </Section>

      <Section title="Logs against video" description="A finding appears only when two independent sources disagree. Agreements are listed too.">
        <div className="overflow-hidden rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-6">Observation</TableHead>
                <TableHead>When</TableHead>
                <TableHead>Sources</TableHead>
                <TableHead className="pr-6 text-right">Result</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deletion.contradictions.map((c) => (
                <TableRow key={c.what}>
                  <TableCell className="max-w-md pl-6 whitespace-normal">{c.what}</TableCell>
                  <TableCell className="tnum">{c.where}</TableCell>
                  <TableCell className="text-muted-foreground">{c.sources}</TableCell>
                  <TableCell className="pr-6 text-right">
                    <Badge variant={c.sev}>
                      {c.sev !== "neutral" && <WarningIcon weight="fill" />}
                      {sevLabel[c.sev]}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Section>

      <Card>
        <CardHeader>
          <CardTitle>Limits of this analysis</CardTitle>
          <CardDescription>
            Solid-state recorders can erase deleted data on their own (TRIM, wear levelling). This case used a spinning disk, so residue was recoverable.
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  )
}
