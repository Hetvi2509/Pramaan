import { useEffect, useRef, useState } from "react"
import { useParams } from "react-router-dom"
import { format } from "date-fns"
import { FolderOpenIcon, PlusIcon, SealCheckIcon } from "@phosphor-icons/react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { DatePicker } from "@/components/pramaan/date-picker"
import { HashValue } from "@/components/pramaan/hash-value"
import { PageHeader } from "@/components/pramaan/page-header"
import { api, type ApiImageFile } from "@/lib/api"

const today = new Date()

function fmtSize(bytes: number | null) {
  if (!bytes) return "—"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let n = bytes
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(n < 10 && i > 0 ? 2 : 0)} ${units[i]}`
}

export default function EvidencePage() {
  const { caseId = "" } = useParams()
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<ApiImageFile[]>([])

  async function reload() {
    try {
      const res = await api.listImages(caseId)
      setItems(res.data)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load evidence")
    }
  }
  useEffect(() => {
    if (caseId) reload()
  }, [caseId])

  return (
    <div className="space-y-10">
      <PageHeader
        eyebrow="Evidence"
        title="Forensic images"
        description="Each image is hashed once on intake. Every clip, frame and finding derived from it traces back to these values."
        actions={
          <Button onClick={() => setOpen(true)}>
            <PlusIcon weight="bold" /> Add image
          </Button>
        }
      />

      <div className="overflow-hidden rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-6">Image</TableHead>
              <TableHead>Size</TableHead>
              <TableHead>SHA-256</TableHead>
              <TableHead className="pr-6 text-right">Integrity</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="pl-6">
                  <div className="space-y-1">
                    <p className="font-medium">{e.filename}</p>
                    <p className="text-caption text-muted-foreground tnum">
                      <span className="font-mono">EV-{e.id}</span>
                      <span aria-hidden className="mx-2">·</span>
                      {format(new Date(e.created_at), "d MMM yyyy, HH:mm")}
                    </p>
                  </div>
                </TableCell>
                <TableCell className="tnum">{fmtSize(e.size_bytes)}</TableCell>
                <TableCell>{e.hash_sha256 ? <HashValue value={e.hash_sha256} label="SHA-256" /> : "—"}</TableCell>
                <TableCell className="pr-6 text-right">
                  <Badge variant={e.hash_sha256 ? "success" : "outline"}>
                    <SealCheckIcon weight="fill" /> {e.hash_sha256 ? "Hashed at intake" : "Pending"}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <AddImageSheet open={open} onOpenChange={setOpen} caseId={caseId} onAdded={reload} />
    </div>
  )
}

function AddImageSheet({
  open,
  onOpenChange,
  caseId,
  onAdded,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  caseId: string
  onAdded: () => void
}) {
  const [acquired, setAcquired] = useState<Date | undefined>(today)
  const [blocker, setBlocker] = useState(true)
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!file) return toast.error("Choose a file first")
    setBusy(true)
    try {
      const res = await api.addImage(caseId, file)
      toast.success("Hashed and added", {
        description: `${res.data.filename} — SHA-256 ${res.data.hash_sha256?.slice(0, 12)}…`,
      })
      onOpenChange(false)
      setFile(null)
      onAdded()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add image")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 sm:max-w-md">
        <form onSubmit={submit} className="flex h-full flex-col">
          <SheetHeader className="space-y-2 p-8 pb-6">
            <SheetTitle className="font-display text-heading font-normal">Add forensic image</SheetTitle>
            <SheetDescription>
              Pick every segment of the image. The source is opened read-only and never modified.
            </SheetDescription>
          </SheetHeader>

          <FieldGroup className="flex-1 gap-6 overflow-y-auto px-8 py-2">
            <Field>
              <FieldLabel>Image file</FieldLabel>
              <div className="flex gap-2">
                <Input readOnly value={file?.name ?? ""} placeholder="No file selected" className="font-mono text-caption" aria-label="Image path" />
                <input
                  ref={fileInput}
                  type="file"
                  className="hidden"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
                <Button type="button" variant="outline" className="shrink-0" onClick={() => fileInput.current?.click()}>
                  <FolderOpenIcon /> Browse
                </Button>
              </div>
              <FieldDescription>Any file works for the smoke test; forensic images are typically .E01, .dd, .img or .raw</FieldDescription>
            </Field>

            <Field>
              <FieldLabel>Source</FieldLabel>
              <Select defaultValue="e01">
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="e01">Acquired image (EWF)</SelectItem>
                  <SelectItem value="dd">Raw image (dd)</SelectItem>
                  <SelectItem value="disk">Physical disk, via write-blocker</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            <div className="grid grid-cols-2 gap-4">
              <Field>
                <FieldLabel>Acquired on</FieldLabel>
                <DatePicker value={acquired} onChange={setAcquired} className="w-full" />
              </Field>
              <Field>
                <FieldLabel>Recorder time zone</FieldLabel>
                <Select defaultValue="ist">
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ist">IST, UTC+05:30</SelectItem>
                    <SelectItem value="utc">UTC</SelectItem>
                    <SelectItem value="unknown">Not known</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>

            <Field orientation="horizontal" className="items-start gap-3">
              <Checkbox id="wb" checked={blocker} onCheckedChange={(v) => setBlocker(v === true)} className="mt-0.5" />
              <div className="space-y-1">
                <FieldLabel htmlFor="wb" className="font-medium">
                  Hardware write-blocker used
                </FieldLabel>
                <FieldDescription>Recorded on the Section 63 certificate.</FieldDescription>
              </div>
            </Field>

            <Field>
              <FieldLabel htmlFor="notes">Custody notes</FieldLabel>
              <Textarea id="notes" rows={3} placeholder="Seal number, who handed over the disk, condition" />
              <FieldDescription className="tnum">
                Entry will be logged {format(today, "d MMM yyyy")} and hash-chained.
              </FieldDescription>
            </Field>
          </FieldGroup>

          <SheetFooter className="flex-row justify-end gap-3 border-t border-hairline p-6">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !file}>{busy ? "Hashing…" : "Hash and add"}</Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
