import { Link, useParams } from "react-router-dom"
import { ArrowRightIcon } from "@phosphor-icons/react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { PageHeader } from "@/components/pramaan/page-header"

const steps = [
  { title: "Connect the recorder's drive through a hardware write blocker", detail: "The blocker stops anything from being written to the original drive while it is read." },
  { title: "Make an image with an imaging tool you trust", detail: "For example FTK Imager, dc3dd or Guymager. Raw (.dd, .img) and Expert Witness (.E01) images are both accepted. Note the MD5 and SHA-256 your tool reports." },
  { title: "Add the image on the Evidence page", detail: "Pramaan hashes the file as it comes in (MD5 and SHA-256) and records that in the audit trail. Compare those values with the ones your imaging tool reported; they must match." },
  { title: "Re-check the hash before you rely on a result", detail: "On the Image Parsing page, Calculate MD5 + SHA-256 / verify compares the file now with the hash taken on intake and records the outcome." },
]

export default function AcquisitionPage() {
  const { caseId = "" } = useParams()
  return (
    <div className="space-y-10">
      <PageHeader
        eyebrow="DVR forensics"
        title="Acquisition"
        description="Pramaan analyses disk images. It does not read or image a drive itself, so the original is never connected to this computer through the app."
        actions={
          <Button asChild>
            <Link to={`/cases/${caseId}/evidence`}>Add evidence <ArrowRightIcon weight="bold" /></Link>
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Bringing a disk into a case</CardTitle>
          <CardDescription>Four steps, done outside Pramaan for the first two.</CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="divide-y divide-hairline">
            {steps.map((s, i) => (
              <li key={s.title} className="flex items-start gap-4 py-4 first:pt-0 last:pb-0">
                <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary-soft text-caption tnum text-primary">{i + 1}</span>
                <div className="space-y-1">
                  <p className="font-medium">{s.title}</p>
                  <p className="text-body text-muted-foreground">{s.detail}</p>
                </div>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      <Alert>
        <AlertDescription>
          Work only on an image, never on the original drive. If a recorder cannot be powered down or its drive cannot be removed, record that in your own notes, because the
          image then reflects the recorder's state at the moment it was taken.
        </AlertDescription>
      </Alert>
    </div>
  )
}
