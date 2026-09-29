import { useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { CheckCircleIcon, WarningIcon } from "@phosphor-icons/react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { DatePicker } from "@/components/pramaan/date-picker"
import { HashValue } from "@/components/pramaan/hash-value"
import { PageHeader } from "@/components/pramaan/page-header"
import { cn } from "@/lib/utils"

const drives = [
  { id: "sda", name: "Seagate SkyHawk ST1000VX005", serial: "ZC1234AB", size: "931.5 GB", note: "Typical DVR disk" },
  { id: "sdb", name: "Western Digital WD40PURZ", serial: "WX21D4567890", size: "3.6 TB", note: "Typical DVR disk" },
  { id: "sdc", name: "SanDisk Ultra USB", serial: "4C530001", size: "29.8 GB", note: "Removable, probably not evidence" },
]

const md5 = "9e107d9d372bb6826bd81d3542a419d6"
const sha = "3f79bb7b435b05321651daefd374cdc681dc06faa65e374e38337b04a7c6f2d1"

function Step({ n, title, done, active, summary, onEdit, children }: { n: number; title: string; done: boolean; active: boolean; summary?: string; onEdit?: () => void; children?: React.ReactNode }) {
  return (
    <Card className={cn(!active && !done && "opacity-60")}>
      <CardHeader>
        <CardTitle className="flex items-center gap-3">
          <span className={cn("grid size-7 place-items-center rounded-full text-caption tnum", done ? "bg-success-soft text-success" : active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>
            {done ? <CheckCircleIcon weight="fill" className="size-5" /> : n}
          </span>
          {title}
          {done && summary && <span className="ml-1 min-w-0 flex-1 truncate font-sans text-body text-muted-foreground">{summary}</span>}
          {done && onEdit && (
            <Button variant="ghost" size="xs" className="ml-auto" onClick={onEdit}>
              Change
            </Button>
          )}
        </CardTitle>
      </CardHeader>
      {active && children && <CardContent>{children}</CardContent>}
    </Card>
  )
}

export default function AcquisitionPage() {
  const navigate = useNavigate()
  const [step, setStep] = useState(0) // 0..3 = current step, 4 = imaged
  const [blocker, setBlocker] = useState("tableau")
  const [confirmed, setConfirmed] = useState(false)
  const [drive, setDrive] = useState("sda")
  const [examiner, setExamin] = useState("R. Deshmukh")
  const [format, setFormat] = useState("e01")
  const [date, setDate] = useState<Date | undefined>(new Date())
  const [recTime, setRecTime] = useState("14:02:10")
  const [refTime, setRefTime] = useState("14:07:38")
  const [progress, setProgress] = useState(0)
  const [phase, setPhase] = useState<"idle" | "imaging" | "hashing" | "done">("idle")
  const timer = useRef<ReturnType<typeof setInterval>>(undefined)
  useEffect(() => () => clearInterval(timer.current), [])

  const d = drives.find((x) => x.id === drive)!
  const diff = (() => {
    const s = (t: string) => t.split(":").reduce((a, b) => a * 60 + +b, 0)
    return s(refTime) - s(recTime)
  })()

  function image() {
    setPhase("imaging")
    setProgress(0)
    let p = 0
    let ph: "imaging" | "hashing" = "imaging"
    timer.current = setInterval(() => {
      p += ph === "imaging" ? 2.5 : 5
      if (p >= 100) {
        if (ph === "imaging") {
          ph = "hashing"
          p = 0
          setPhase("hashing")
        } else {
          clearInterval(timer.current)
          setPhase("done")
          setStep(4)
          toast.success("Image verified", { description: "Source and image hashes match." })
          return
        }
      }
      setProgress(p)
    }, 110)
  }

  return (
    <div className="space-y-10">
      <PageHeader
        eyebrow="DVR forensics"
        title="Acquisition"
        description="Make a forensic image of a recorder's disk without altering it. Every step is written to the audit trail."
      />

      <div className="max-w-3xl space-y-6">
        <Step n={1} title="Write-blocker" done={step > 0} active={step === 0} summary={blocker === "none" ? "None used" : blocker === "tableau" ? "Tableau T35u, read-only confirmed" : "WiebeTech Ultradock, read-only confirmed"} onEdit={phase === "idle" ? () => setStep(0) : undefined}>
          <div className="space-y-6">
            <Field>
              <FieldLabel>Write-blocker</FieldLabel>
              <Select value={blocker} onValueChange={setBlocker}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="tableau">Tableau T35u (USB 3.0)</SelectItem>
                  <SelectItem value="wiebe">WiebeTech Ultradock</SelectItem>
                  <SelectItem value="none">No write-blocker (not recommended)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            {blocker === "none" ? (
              <p className="flex gap-2.5 rounded-md bg-warning-soft px-4 py-3 text-warning">
                <WarningIcon weight="fill" className="mt-0.5 size-4 shrink-0" />
                Imaging without a write-blocker can change the disk. This will be recorded on the certificate.
              </p>
            ) : (
              <div className="flex items-start gap-2.5">
                <Checkbox id="wb" checked={confirmed} onCheckedChange={(v) => setConfirmed(v === true)} className="mt-0.5" />
                <label htmlFor="wb" className="text-body">
                  The write-blocker is connected between the disk and this computer, and its read-only light is on.
                </label>
              </div>
            )}
            <Button disabled={blocker !== "none" && !confirmed} onClick={() => setStep(1)}>
              Continue
            </Button>
          </div>
        </Step>

        <Step n={2} title="Source disk" done={step > 1} active={step === 1} summary={`${d.name}, ${d.size}`} onEdit={phase === "idle" ? () => setStep(1) : undefined}>
          <div className="space-y-6">
            <RadioGroup value={drive} onValueChange={setDrive} className="gap-3">
              {drives.map((x) => (
                <label
                  key={x.id}
                  htmlFor={x.id}
                  className={cn("flex cursor-pointer items-center gap-4 rounded-lg border p-4 transition-colors duration-150", drive === x.id ? "border-primary bg-primary-soft" : "hover:bg-muted")}
                >
                  <RadioGroupItem id={x.id} value={x.id} />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{x.name}</span>
                    <span className="block font-mono text-caption text-muted-foreground">Serial {x.serial}</span>
                  </span>
                  <span className="text-right">
                    <span className="block tnum">{x.size}</span>
                    <span className="block text-caption text-muted-foreground">{x.note}</span>
                  </span>
                </label>
              ))}
            </RadioGroup>
            <div className="flex gap-3">
              <Button variant="ghost" onClick={() => setStep(0)}>Back</Button>
              <Button onClick={() => setStep(2)}>Continue</Button>
            </div>
          </div>
        </Step>

        <Step n={3} title="Examiner and clock" done={step > 2} active={step === 2} summary={`${examiner}, recorder ${Math.abs(diff)} s ${diff >= 0 ? "behind" : "ahead"}`} onEdit={phase === "idle" ? () => setStep(2) : undefined}>
          <div className="space-y-6">
            <div className="grid gap-5 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="ex">Examiner</FieldLabel>
                <Input id="ex" value={examiner} onChange={(e) => setExamin(e.target.value)} />
              </Field>
              <Field>
                <FieldLabel>Image format</FieldLabel>
                <Select value={format} onValueChange={setFormat}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="e01">EnCase (.E01), compressed</SelectItem>
                    <SelectItem value="dd">Raw (.dd)</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <div className="space-y-4 rounded-lg bg-muted p-5">
              <div>
                <p className="font-medium">Clock reference</p>
                <p className="text-caption text-muted-foreground">Photograph the recorder's on-screen clock next to a time-synced reference, then enter both. This sets how far every timestamp can be trusted.</p>
              </div>
              <div className="grid gap-5 sm:grid-cols-3">
                <Field>
                  <FieldLabel>Date</FieldLabel>
                  <DatePicker value={date} onChange={setDate} className="w-full bg-card" />
                </Field>
                <Field>
                  <FieldLabel htmlFor="rt">Recorder clock</FieldLabel>
                  <Input id="rt" value={recTime} onChange={(e) => setRecTime(e.target.value)} className="bg-card font-mono tnum" placeholder="HH:MM:SS" />
                </Field>
                <Field>
                  <FieldLabel htmlFor="ft">Reference clock</FieldLabel>
                  <Input id="ft" value={refTime} onChange={(e) => setRefTime(e.target.value)} className="bg-card font-mono tnum" placeholder="HH:MM:SS" />
                </Field>
              </div>
              <FieldDescription>
                Recorder is {Math.abs(diff) || 0} s {diff >= 0 ? "behind" : "ahead of"} the reference.
              </FieldDescription>
            </div>
            <div className="flex gap-3">
              <Button variant="ghost" onClick={() => setStep(1)}>Back</Button>
              <Button disabled={!examiner.trim()} onClick={() => setStep(3)}>Continue</Button>
            </div>
          </div>
        </Step>

        <Step n={4} title="Create and verify the image" done={step > 3} active={step === 3} summary="Verified">
          <div className="space-y-6">
            <dl className="grid grid-cols-[9rem_1fr] gap-y-2 text-body">
              <dt className="text-muted-foreground">Source</dt>
              <dd>{d.name} · {d.size}</dd>
              <dt className="text-muted-foreground">Write-blocker</dt>
              <dd>{blocker === "none" ? "None" : blocker === "tableau" ? "Tableau T35u" : "WiebeTech Ultradock"}</dd>
              <dt className="text-muted-foreground">Format</dt>
              <dd>{format === "e01" ? "EnCase (.E01)" : "Raw (.dd)"}, MD5 and SHA-256</dd>
            </dl>
            {phase !== "idle" && (
              <div className="space-y-2">
                <div className="flex justify-between text-caption text-muted-foreground tnum">
                  <span>{phase === "imaging" ? "Imaging at 148 MB/s" : "Re-reading the image to verify"}</span>
                  <span>{Math.round(progress)}%</span>
                </div>
                <Progress value={progress} className="h-1.5" />
              </div>
            )}
            <div className="flex gap-3">
              <Button variant="ghost" disabled={phase !== "idle"} onClick={() => setStep(2)}>Back</Button>
              <Button disabled={phase !== "idle"} onClick={image}>
                {phase === "idle" ? "Start imaging" : "Working…"}
              </Button>
            </div>
          </div>
        </Step>

        {step === 4 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2.5">
                <CheckCircleIcon weight="fill" className="size-5 text-success" /> Image verified
              </CardTitle>
              <CardDescription>The hashes of the disk and of the image are identical, so the image is a faithful copy.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <dl className="grid grid-cols-[6rem_1fr] items-center gap-y-2 text-caption">
                <dt className="text-muted-foreground">MD5</dt>
                <dd><HashValue value={md5} label="MD5" /></dd>
                <dt className="text-muted-foreground">SHA-256</dt>
                <dd><HashValue value={sha} label="SHA-256" /></dd>
              </dl>
              <div className="flex flex-wrap gap-2">
                <Badge variant="success">Hashes match</Badge>
                <Badge variant="neutral" className="tnum">931.5 GB read in 1 h 47 min</Badge>
                <Badge variant="warning" className="tnum">1 unreadable range, zero-filled and logged</Badge>
              </div>
              <Button onClick={() => navigate("../parsing", { relative: "path" })}>Add to case and parse</Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
