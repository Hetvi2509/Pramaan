import { useMemo, useState } from "react"
import { DotsThreeIcon, DownloadSimpleIcon, SealCheckIcon } from "@phosphor-icons/react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { HashValue } from "@/components/pramaan/hash-value"
import { PageHeader } from "@/components/pramaan/page-header"
import { FootageDot } from "@/components/pramaan/status"
import { clips, type FootageStatus } from "@/lib/mock"

const tabs: { value: "all" | FootageStatus; label: string }[] = [
  { value: "all", label: "All" },
  { value: "live", label: "Live" },
  { value: "deleted", label: "Deleted" },
  { value: "repaired", label: "Repaired" },
  { value: "excluded", label: "Excluded" },
]

export default function RecoveryPage() {
  const [tab, setTab] = useState<string>("all")
  const [ch, setCh] = useState("all")

  const channels = [...new Set(clips.map((c) => c.ch))]
  const rows = useMemo(
    () =>
      clips.filter((c) => {
        if (ch !== "all" && c.ch !== ch) return false
        if (tab === "all") return true
        return tab === "excluded" ? c.gate === "excluded" : c.status === tab && c.gate === "passed"
      }),
    [tab, ch]
  )
  const count = (v: string) =>
    clips.filter((c) => (v === "all" ? true : v === "excluded" ? c.gate === "excluded" : c.status === v && c.gate === "passed")).length

  return (
    <div className="space-y-10">
      <PageHeader
        eyebrow="Recovery"
        title="Recovered clips"
        description="One MP4 per channel run, with real timestamps. Each clip is decode-checked before it can reach analytics."
        actions={
          <Button variant="outline" onClick={() => toast.success("Exporting 4 clips", { description: "Manifests are written beside each file." })}>
            <DownloadSimpleIcon /> Export passed clips
          </Button>
        }
      />

      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              {tabs.map((t) => (
                <TabsTrigger key={t.value} value={t.value} className="gap-2">
                  {t.label}
                  <span className="text-caption text-muted-foreground tnum">{count(t.value)}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <Select value={ch} onValueChange={setCh}>
            <SelectTrigger className="w-44" aria-label="Channel">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All channels</SelectItem>
              {channels.map((c) => (
                <SelectItem key={c} value={c}>{c}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="overflow-hidden rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-6">Clip</TableHead>
                <TableHead>Recovered as</TableHead>
                <TableHead>Recorded</TableHead>
                <TableHead className="text-right">Continuity</TableHead>
                <TableHead>Quality gate</TableHead>
                <TableHead className="pr-6 text-right"><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="pl-6">
                    <div className="space-y-1">
                      <p className="font-medium">{c.ch}, {c.name}</p>
                      <p className="font-mono text-caption text-muted-foreground">{c.id}</p>
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-2 capitalize"><FootageDot status={c.status} /> {c.status}</span>
                  </TableCell>
                  <TableCell>
                    <div className="space-y-1">
                      <p className="tnum">{c.range}</p>
                      <p className="text-caption text-muted-foreground tnum">{c.duration}</p>
                    </div>
                  </TableCell>
                  <TableCell className="text-right tnum">{c.continuity.toFixed(2)}</TableCell>
                  <TableCell>
                    {c.gate === "passed" ? (
                      <Badge variant="success"><SealCheckIcon weight="fill" /> Passed</Badge>
                    ) : (
                      <div className="space-y-1">
                        <Badge variant="warning">Excluded</Badge>
                        <p className="max-w-56 text-caption whitespace-normal text-muted-foreground">{c.reason}</p>
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="pr-6 text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${c.id}`}>
                          <DotsThreeIcon weight="bold" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-64">
                        <DropdownMenuItem onSelect={() => toast.success("Manifest verified", { description: `${c.id} re-extracted and re-hashed.` })}>
                          Verify manifest
                        </DropdownMenuItem>
                        <DropdownMenuItem disabled={c.gate === "excluded"}>Export MP4</DropdownMenuItem>
                        <div className="px-2 py-1.5"><HashValue value={c.sha} label="SHA-256" /></div>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <p className="text-caption text-muted-foreground">
          Excluded clips are not analysed but stay in the report as “recovered, not analysed”. An examiner can still watch them.
        </p>
      </div>
    </div>
  )
}
