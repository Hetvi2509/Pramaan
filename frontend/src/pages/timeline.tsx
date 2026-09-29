import { useState } from "react"
import { CheckCircleIcon, MinusCircleIcon, WarningCircleIcon } from "@phosphor-icons/react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { DatePicker } from "@/components/pramaan/date-picker"
import { PageHeader, Section } from "@/components/pramaan/page-header"
import { FootageDot, footageSwatch } from "@/components/pramaan/status"
import { axisMinutes, formatWindow, lanes, witnesses, type FootageStatus } from "@/lib/mock"
import { cn } from "@/lib/utils"

const hours = [0, 1, 2, 3, 4, 5, 6]
const pct = (m: number) => (m / axisMinutes) * 100
const clock = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`
const legend: FootageStatus[] = ["live", "deleted", "excluded"]

export default function TimelinePage() {
  const [day, setDay] = useState<Date | undefined>(new Date(2026, 8, 14))
  const [zone, setZone] = useState("utc")

  return (
    <div className="space-y-12">
      <PageHeader
        eyebrow="Timeline"
        title="What was recorded, and when"
        description="Every time is shown with the uncertainty it carries. A wide band is a fact about the evidence, not a flaw in the tool."
        actions={
          <>
            <DatePicker value={day} onChange={setDay} className="w-44" />
            <ToggleGroup type="single" value={zone} onValueChange={(v) => v && setZone(v)} variant="outline" aria-label="Time display">
              <ToggleGroupItem value="utc" className="px-3.5">UTC</ToggleGroupItem>
              <ToggleGroupItem value="ist" className="px-3.5">IST</ToggleGroupItem>
            </ToggleGroup>
          </>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Channels</CardTitle>
          <CardDescription>
            14 Sep, 00:00 to 06:00 IST, on one clock. Hatching marks the window in which the disk was formatted; nothing was recorded or recoverable inside it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid grid-cols-[6rem_1fr] gap-x-2">
            {/* Track area: window overlay, hour gridlines and lanes share one coordinate space. */}
            <div className="col-start-2">
              <div className="relative h-6 text-caption text-muted-foreground">
                <span
                  className="absolute bottom-1 -translate-x-1/2 font-medium whitespace-nowrap text-foreground"
                  style={{ left: `${pct((formatWindow.start + formatWindow.end) / 2)}%` }}
                >
                  Formatted
                </span>
              </div>
            </div>
            <div className="divide-y-0">
              {lanes.map((l) => (
                <div key={l.ch} className="flex h-11 flex-col justify-center">
                  <p className="font-mono text-caption leading-tight">{l.ch}</p>
                  <p className="text-caption leading-tight text-muted-foreground">{l.name}</p>
                </div>
              ))}
            </div>
            <div className="relative">
              {hours.map((h) => (
                <span
                  key={h}
                  aria-hidden
                  className="absolute inset-y-0 w-px bg-hairline"
                  style={{ left: `${pct(h * 60)}%` }}
                />
              ))}
              <div
                aria-hidden
                className="absolute inset-y-0 rounded-sm bg-[repeating-linear-gradient(135deg,var(--hairline)_0_1px,transparent_1px_6px)] ring-1 ring-foreground/20 ring-inset"
                style={{ left: `${pct(formatWindow.start)}%`, width: `${pct(formatWindow.end - formatWindow.start)}%` }}
              />
              {lanes.map((l) => (
                <div key={l.ch} className="relative flex h-11 items-center">
                  <div className="relative h-3.5 w-full">
                    {l.segs.map((sg, i) => (
                      <Tooltip key={i}>
                        <TooltipTrigger asChild>
                          <span
                            tabIndex={0}
                            className={cn(
                              "absolute inset-y-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2",
                              footageSwatch[sg.k]
                            )}
                            style={{ left: `${pct(sg.s)}%`, width: `${pct(sg.e - sg.s)}%` }}
                          />
                        </TooltipTrigger>
                        <TooltipContent>
                          <span className="capitalize">{sg.k}</span> footage, <span className="tnum">{clock(sg.s)} to {clock(sg.e)}</span>
                        </TooltipContent>
                      </Tooltip>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div />
            <div className="relative mt-2 h-5 text-caption text-muted-foreground tnum">
              {hours.map((h) => (
                <span
                  key={h}
                  className={cn("absolute -translate-x-1/2", h === 0 && "translate-x-0", h === 6 && "-translate-x-full")}
                  style={{ left: `${pct(h * 60)}%` }}
                >
                  {String(h).padStart(2, "0")}:00
                </span>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-hairline pt-5 text-caption text-muted-foreground">
            {legend.map((k) => (
              <span key={k} className="inline-flex items-center gap-2 capitalize">
                <FootageDot status={k} /> {k}
              </span>
            ))}
            <span className="ml-auto text-foreground">
              {formatWindow.label}: <span className="tnum">{formatWindow.range}</span>{" "}
              <Badge variant="neutral" className="ml-1 tnum">{formatWindow.sigma}</Badge>
            </span>
          </div>
        </CardContent>
      </Card>

      <Section
        title="Clock witnesses"
        description="A tamper flag is only raised when two independent clocks disagree, and it names which two."
        action={
          <Select defaultValue="all">
            <SelectTrigger size="sm" className="w-44" aria-label="Channel">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All channels</SelectItem>
              {lanes.map((l) => (
                <SelectItem key={l.ch} value={l.ch}>{l.ch}, {l.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      >
        <div className="overflow-hidden rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-6 w-14">ID</TableHead>
                <TableHead>Witness</TableHead>
                <TableHead>Independent of recorder</TableHead>
                <TableHead>Offset</TableHead>
                <TableHead className="pr-6 text-right">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {witnesses.map((w) => (
                <TableRow key={w.id}>
                  <TableCell className="pl-6 font-mono text-caption text-muted-foreground">{w.id}</TableCell>
                  <TableCell>
                    <div className="space-y-1">
                      <p className="font-medium">{w.name}</p>
                      <p className="text-caption text-muted-foreground">{w.source}</p>
                    </div>
                  </TableCell>
                  <TableCell>{w.independent ? "Yes" : "No, same clock"}</TableCell>
                  <TableCell className="tnum">{w.offset}</TableCell>
                  <TableCell className="pr-6 text-right">
                    {w.state === "agrees" && (
                      <Badge variant="success"><CheckCircleIcon weight="fill" /> Consistent</Badge>
                    )}
                    {w.state === "missing" && (
                      <Badge variant="warning"><MinusCircleIcon weight="fill" /> Not entered</Badge>
                    )}
                    {w.state === "conflict" && (
                      <Badge variant="danger"><WarningCircleIcon weight="fill" /> Conflict</Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <p className="text-caption text-muted-foreground">
          Add W4 to replace the single NTP-log anchor and narrow absolute time from ±1.4 s to about ±1 s.{" "}
          <Button variant="link" size="xs" className="h-auto p-0 text-caption">Enter seizure anchor</Button>
        </p>
      </Section>
    </div>
  )
}
