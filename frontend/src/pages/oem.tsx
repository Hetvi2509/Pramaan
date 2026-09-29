import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { PageHeader } from "@/components/pramaan/page-header"

type Status = "hardware" | "synthetic" | "pending" | "research"
const label: Record<Status, string> = {
  hardware: "Tested on disk",
  synthetic: "Synthetic image",
  pending: "Built, disk pending",
  research: "Desk research only",
}
const tone: Record<Status, "success" | "primary" | "warning" | "neutral"> = { hardware: "success", synthetic: "primary", pending: "warning", research: "neutral" }

// Status follows plan.md Section 4.1: a figure is only shown for a vendor we actually imaged.
const oems = [
  { name: "Hikvision", status: "hardware" as Status, layout: "MPEG-PS in HIKBTREE blocks", time: "Local clock as epoch (verify)", frames: "0.98", deleted: "0.91", blind: "Adapter" },
  { name: "Dahua", status: "pending" as Status, layout: "DHFS with DHAV records", time: "Packed date, local time", frames: "n/a", deleted: "n/a", blind: "Target 0.90" },
  { name: "CP Plus", status: "pending" as Status, layout: "Expected DHAV (to verify)", time: "Expected packed date", frames: "n/a", deleted: "n/a", blind: "n/a" },
  { name: "Honeywell", status: "synthetic" as Status, layout: "GPT, 20-byte record header", time: "Unix microseconds", frames: "n/a", deleted: "n/a", blind: "n/a" },
  { name: "Uniview", status: "pending" as Status, layout: "Unknown, to be induced", time: "Unknown", frames: "n/a", deleted: "n/a", blind: "n/a" },
  { name: "Godrej", status: "pending" as Status, layout: "Unknown, to be induced", time: "Unknown", frames: "n/a", deleted: "n/a", blind: "n/a" },
  { name: "Matrix", status: "pending" as Status, layout: "Unknown, to be induced", time: "Unknown", frames: "n/a", deleted: "n/a", blind: "n/a" },
  { name: "TP-Link", status: "research" as Status, layout: "From teardown reports", time: "Not known", frames: "n/a", deleted: "n/a", blind: "n/a" },
]

export default function OemPage() {
  const [f, setF] = useState("all")
  const rows = oems.filter((o) => f === "all" || (f === "tested" ? o.status === "hardware" || o.status === "synthetic" : o.status === "pending" || o.status === "research"))
  const tested = oems.filter((o) => o.status === "hardware").length
  return (
    <div className="space-y-10">
      <PageHeader
        eyebrow="Workspace"
        title="OEM comparison"
        description="How each recorder brand stores video, and how far we have validated our parsers against it. A blank is a blank, not a pass."
      />

      <div className="grid gap-x-10 gap-y-6 sm:grid-cols-4">
        {[
          [String(oems.length), "Brands covered"],
          [String(tested), "Tested on a real disk"],
          ["1", "Synthetic image, labelled"],
          [String(oems.filter((o) => o.status === "pending").length), "Waiting for a disk"],
        ].map(([n, l]) => (
          <div key={l} className="space-y-1">
            <p className="font-display text-title tnum">{n}</p>
            <p className="text-caption text-muted-foreground">{l}</p>
          </div>
        ))}
      </div>

      <Alert>
        <AlertDescription>
          Only Hikvision has been run on a real disk so far. Dahua and CP Plus parsers exist but have not yet been checked against hardware. Figures appear here as each recorder is imaged.
        </AlertDescription>
      </Alert>

      <div className="space-y-5">
        <ToggleGroup type="single" value={f} onValueChange={(v) => v && setF(v)} variant="outline" aria-label="Filter brands">
          <ToggleGroupItem value="all" className="px-4">All</ToggleGroupItem>
          <ToggleGroupItem value="tested" className="px-4">Tested</ToggleGroupItem>
          <ToggleGroupItem value="not" className="px-4">Not yet tested</ToggleGroupItem>
        </ToggleGroup>

        <div className="overflow-x-auto rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-6">Brand</TableHead>
                <TableHead>Validation</TableHead>
                <TableHead>Storage layout</TableHead>
                <TableHead>Time encoding</TableHead>
                <TableHead className="text-right">Frames found</TableHead>
                <TableHead className="text-right">Deleted found</TableHead>
                <TableHead className="pr-6">Blind</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((o) => (
                <TableRow key={o.name}>
                  <TableCell className="pl-6 font-medium">{o.name}</TableCell>
                  <TableCell>
                    <Badge variant={tone[o.status]}>{label[o.status]}</Badge>
                  </TableCell>
                  <TableCell>{o.layout}</TableCell>
                  <TableCell className="text-muted-foreground">{o.time}</TableCell>
                  <TableCell className="text-right tnum">{o.frames}</TableCell>
                  <TableCell className="text-right tnum">{o.deleted}</TableCell>
                  <TableCell className="pr-6 text-muted-foreground">{o.blind}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <p className="text-caption text-muted-foreground">
          Found is the share of frames the parser found that a manual count also found, on that brand's own test disk. “Blind” is how well the layout was worked out with the brand's
          parser switched off.
        </p>
      </div>
    </div>
  )
}
