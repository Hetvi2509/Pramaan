import { useEffect, useMemo, useState } from "react"
import { useParams } from "react-router-dom"
import { CheckCircleIcon, WarningIcon } from "@phosphor-icons/react"
import { toast } from "sonner"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { PageHeader } from "@/components/pramaan/page-header"
import { api, getUser, type ApiCase } from "@/lib/api"
import { loadCaseData, useCaseData } from "@/lib/case-data"
import { buildReportData, computeSections, downloadJson, openPrintable, renderReportHtml, sha256Hex } from "@/lib/report"
import { cn } from "@/lib/utils"

const formats = [
  { id: "pdf", label: "PDF report", hint: "For the file and for court" },
  { id: "json", label: "JSON", hint: "Machine-readable, same content" },
  { id: "s63", label: "BSA Section 63(4) certificate", hint: "Included as a section, with hash values" },
]

export default function ReportPage() {
  const { caseId = "" } = useParams()
  const [picked, setPicked] = useState<string[]>(["pdf", "s63"])
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [part, setPart] = useState<"a" | "b">("b")
  const [expertName, setExpertName] = useState(getUser()?.username ?? "")

  const [realCase, setRealCase] = useState<ApiCase | null>(null)
  const data = useCaseData(caseId)

  useEffect(() => {
    if (!caseId) return
    api.getCase(caseId).then((r) => setRealCase(r.data)).catch(() => setRealCase(null))
  }, [caseId])

  const sections = useMemo(() => computeSections(data), [data])
  const open = sections.filter((s) => !s.ready)

  const toggle = (id: string, on: boolean) => setPicked((p) => (on ? [...p, id] : p.filter((x) => x !== id)))

  async function generate() {
    setConfirm(false)
    setBusy(true)
    try {
      // Read the evidence again now, so the report reflects the case as it stands at this moment.
      const fresh = await loadCaseData(caseId)
      const report = buildReportData(realCase, caseId, fresh, { part, expertName }, getUser()?.username ?? "Examiner")
      const reportHash = await sha256Hex(JSON.stringify(report))

      if (picked.includes("pdf") || picked.includes("s63")) {
        openPrintable(renderReportHtml(report, picked, reportHash))
      }
      if (picked.includes("json")) {
        downloadJson(report, reportHash, `${report.caseInfo.id || "report"}-${format(report.generatedAt)}.json`)
      }
      // The audit trail records that this report exists, by its hash.
      const logged = await api.reportGenerated(caseId, reportHash, picked).then(() => true).catch(() => false)
      toast.success("Report generated", { description: `${picked.length} file${picked.length === 1 ? "" : "s"} produced, hash ${reportHash.slice(0, 12)}…${logged ? "" : " (could not be added to the audit trail)"}` })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to generate report")
    } finally {
      setBusy(false)
    }
  }

  function format(d: Date) {
    return d.toISOString().slice(0, 10)
  }

  return (
    <div className="space-y-12">
      <PageHeader
        eyebrow="Report"
        title="Report and Section 63 certificate"
        description="Everything that leaves this machine is generated here, with the methods, limits and hashes that let someone else check it."
        actions={
          <Button disabled={!picked.length || busy} onClick={() => (open.length ? setConfirm(true) : generate())}>
            {busy ? "Generating…" : "Generate report"}
          </Button>
        }
      />

      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <Card>
          <CardHeader>
            <CardTitle>Contents</CardTitle>
            <CardDescription><span className="tnum">{sections.length - open.length} of {sections.length}</span> sections are ready.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-hairline">
              {sections.map((s) => (
                <li key={s.name} className="flex items-start gap-3 py-3.5 first:pt-0 last:pb-0">
                  {s.ready ? (
                    <CheckCircleIcon weight="fill" className="mt-0.5 size-5 shrink-0 text-success" aria-label="Ready" />
                  ) : (
                    <WarningIcon weight="fill" className="mt-0.5 size-5 shrink-0 text-warning" aria-label="Incomplete" />
                  )}
                  <div>
                    <p className={cn("font-medium")}>{s.name}</p>
                    {s.note && <p className="text-caption text-muted-foreground">{s.note}</p>}
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <div className="space-y-8">
          <Card>
            <CardHeader>
              <CardTitle>Files</CardTitle>
            </CardHeader>
            <CardContent>
              <FieldGroup className="gap-4">
                {formats.map((f) => (
                  <Field key={f.id} orientation="horizontal" className="items-start gap-3">
                    <Checkbox id={f.id} checked={picked.includes(f.id)} onCheckedChange={(v) => toggle(f.id, v === true)} className="mt-0.5" />
                    <div className="space-y-0.5">
                      <FieldLabel htmlFor={f.id} className="font-medium">{f.label}</FieldLabel>
                      <FieldDescription>{f.hint}</FieldDescription>
                    </div>
                  </Field>
                ))}
              </FieldGroup>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Certificate</CardTitle>
              <CardDescription>Under Section 63(4), who is certifying.</CardDescription>
            </CardHeader>
            <CardContent>
              <FieldGroup className="gap-5">
                <RadioGroup value={part} onValueChange={(v) => setPart(v as "a" | "b")} className="gap-3">
                  <Field orientation="horizontal" className="items-center gap-3">
                    <RadioGroupItem value="a" id="pa" />
                    <FieldLabel htmlFor="pa" className="font-normal">Part A, by the party</FieldLabel>
                  </Field>
                  <Field orientation="horizontal" className="items-center gap-3">
                    <RadioGroupItem value="b" id="pb" />
                    <FieldLabel htmlFor="pb" className="font-normal">Part B, by the expert</FieldLabel>
                  </Field>
                </RadioGroup>
                <Field>
                  <FieldLabel htmlFor="expert">Expert name</FieldLabel>
                  <Input id="expert" value={expertName} placeholder="Name of the certifying expert" onChange={(e) => setExpertName(e.target.value)} />
                </Field>
              </FieldGroup>
            </CardContent>
          </Card>
        </div>
      </div>

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-display text-heading font-normal">Generate with {open.length} open items?</AlertDialogTitle>
            <AlertDialogDescription>
              The report will state these as limitations: {open.map((o) => o.note?.toLowerCase()).join("; ")}. You can resolve them first and regenerate.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Go back</AlertDialogCancel>
            <AlertDialogAction onClick={generate}>Generate anyway</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
