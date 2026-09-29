import { useState } from "react"
import { InfoIcon } from "@phosphor-icons/react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PageHeader, Section } from "@/components/pramaan/page-header"
import { FootageDot } from "@/components/pramaan/status"
import { coverage, detections } from "@/lib/mock"

const tasks = [
  { value: "all", label: "All" },
  { value: "objects", label: "Objects" },
  { value: "motion", label: "Motion" },
  { value: "faces", label: "Faces" },
]

export default function AnalyticsPage() {
  const [task, setTask] = useState("all")
  const rows = detections.filter((d) => task === "all" || d.task === task)

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
              {rows.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="pl-6">
                    <span className="font-medium">{d.cls}</span>{" "}
                    <span className="font-mono text-caption text-muted-foreground">{d.id}</span>
                  </TableCell>
                  <TableCell className="font-mono text-caption">{d.ch}</TableCell>
                  <TableCell className="tnum">{d.t}</TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-2 capitalize"><FootageDot status={d.status} /> {d.status}</span>
                  </TableCell>
                  <TableCell className="pr-6 text-right tnum">{Math.round(d.conf * 100)}%</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      <Section title="What was checked" description="Anything not analysed is listed here and in the report.">
        <Card>
          <CardContent className="divide-y divide-hairline">
            {coverage.map((c) => (
              <div key={c.ch} className="grid items-center gap-x-6 gap-y-2 py-4 first:pt-0 last:pb-0 md:grid-cols-[5rem_1fr_16rem_3rem]">
                <span className="font-mono text-caption">{c.ch}</span>
                <Progress value={c.checked} aria-label={`${c.ch} coverage`} className="h-2" />
                <span className="text-caption text-muted-foreground">{c.method}</span>
                <span className="text-right tnum">{c.checked}%</span>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2.5">Not analysed <Badge variant="warning" className="tnum">2</Badge></CardTitle>
            <CardDescription>C-0413 and C-0431 failed the quality gate. Detections there would come from decode noise.</CardDescription>
          </CardHeader>
        </Card>
      </Section>
    </div>
  )
}
