import { useEffect, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { format } from "date-fns"
import { ArrowRightIcon, LinkSimpleIcon, PlusIcon, SealCheckIcon, WarningIcon } from "@phosphor-icons/react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { HashValue } from "@/components/pramaan/hash-value"
import { PageHeader, Section } from "@/components/pramaan/page-header"
import { FootageDot, StepIcon, footageSwatch } from "@/components/pramaan/status"
import { attention, audit, cases as mockCases, evidence, footage, pipeline } from "@/lib/mock"
import { cn } from "@/lib/utils"
import { api, type ApiCase } from "@/lib/api"

export default function OverviewPage() {
  const { caseId } = useParams()
  const [real, setReal] = useState<ApiCase | null>(null)
  useEffect(() => {
    if (caseId) api.getCase(caseId).then((r) => setReal(r.data)).catch(() => setReal(null))
  }, [caseId])
  // Real case metadata (name, created_at) comes from the backend; the rest of this page
  // (pipeline, footage, attention, audit) is still fixture data — those forensic stages
  // are out of scope for this port, see plan.md.
  const c = real
    ? { id: String(real.id), title: real.name, fir: "", station: real.description ?? "Not set", examiner: "—", opened: real.created_at }
    : mockCases.find((x) => x.id === caseId) ?? mockCases[0]
  const total = footage.reduce((n, f) => n + f.clips, 0)

  return (
    <div className="space-y-14">
      <PageHeader
        eyebrow={
          <>
            <span className="font-mono normal-case">{c.id}</span>
            {c.fir && (
              <>
                <span aria-hidden className="mx-2">·</span>
                {c.fir}
              </>
            )}
          </>
        }
        title={c.title}
        description={`${c.station}. Examiner ${c.examiner}, opened ${format(new Date(c.opened), "d MMMM yyyy")}.`}
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to="evidence">
                <PlusIcon /> Add evidence
              </Link>
            </Button>
            <Button asChild>
              <Link to="timeline">
                Continue to timeline <ArrowRightIcon weight="bold" />
              </Link>
            </Button>
          </>
        }
      />

      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-8">
          {/* Honest reporting: what was skipped or uncertain comes first. */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2.5">
                Needs your attention
                <Badge variant="warning" className="tnum">
                  {attention.length}
                </Badge>
              </CardTitle>
              <CardDescription>Nothing is skipped silently. These stay visible in the report until resolved.</CardDescription>
            </CardHeader>
            <CardContent className="divide-y divide-hairline">
              {attention.map((a) => (
                <div key={a.id} className="flex items-start gap-4 py-5 first:pt-1 last:pb-0">
                  <WarningIcon weight="fill" className="mt-0.5 size-5 shrink-0 text-warning" />
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="font-medium">{a.title}</p>
                    <p className="text-body text-muted-foreground">{a.detail}</p>
                  </div>
                  <Button variant="outline" size="sm" asChild className="shrink-0">
                    <Link to={a.to}>{a.action}</Link>
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Pipeline</CardTitle>
              <CardDescription>From sealed disk image to a court-ready report.</CardDescription>
            </CardHeader>
            <CardContent>
              <ol className="divide-y divide-hairline">
                {pipeline.map((s) => (
                  <li key={s.key} className="flex items-center gap-4 py-3.5 first:pt-1 last:pb-0">
                    <StepIcon state={s.state} />
                    <div className="w-28 shrink-0">
                      <p className={cn("font-medium", s.state === "todo" && "text-muted-foreground")}>{s.label}</p>
                    </div>
                    <p className="min-w-0 flex-1 truncate text-body text-muted-foreground">{s.result}</p>
                    <span className="font-mono text-caption text-muted-foreground">{s.module}</span>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-8">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <SealCheckIcon weight="fill" className="size-5 text-success" />
                Evidence integrity
              </CardTitle>
              <CardDescription>Hashed on intake, re-verified on every export.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {evidence.map((e) => (
                <div key={e.id} className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-body font-medium">{e.name}</p>
                    <span className="font-mono text-caption text-muted-foreground">{e.id}</span>
                  </div>
                  <dl className="grid grid-cols-[4.25rem_1fr] items-center gap-y-0.5 text-caption">
                    <dt className="text-muted-foreground">MD5</dt>
                    <dd><HashValue value={e.md5} label="MD5" /></dd>
                    <dt className="text-muted-foreground">SHA-256</dt>
                    <dd><HashValue value={e.sha256} label="SHA-256" /></dd>
                  </dl>
                </div>
              ))}
              <div className="flex items-center gap-2 border-t border-hairline pt-4 text-caption text-muted-foreground">
                <LinkSimpleIcon className="size-4 shrink-0" />
                <span>
                  Audit chain head <code className="font-mono text-foreground">a41f09c2</code>
                </span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Recovered footage</CardTitle>
              <CardDescription className="tnum">{total} clips across 16 channels</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-full" role="img" aria-label="Clips by recovery status">
                {footage.map((f) => (
                  <span key={f.status} className={cn("h-full", footageSwatch[f.status])} style={{ flexBasis: `${(f.clips / total) * 100}%` }} />
                ))}
              </div>
              <ul className="space-y-3">
                {footage.map((f) => (
                  <li key={f.status} className="flex items-baseline gap-3">
                    <FootageDot status={f.status} className="translate-y-px" />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{f.label}</p>
                      <p className="text-caption text-muted-foreground">{f.hint}</p>
                    </div>
                    <span className="font-display text-heading tnum">{f.clips}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      </div>

      <Section title="Recent activity" description="The last five entries of this case's hash-chained audit log.">
        <div className="overflow-hidden rounded-lg border bg-card">
          <ul className="divide-y divide-hairline">
            {audit.map((a) => (
              <li key={a.hash} className="grid grid-cols-[9rem_10rem_1fr_auto] items-center gap-4 px-6 py-3.5 text-body">
                <span className="text-muted-foreground tnum">{a.t}</span>
                <span className="text-muted-foreground">{a.who}</span>
                <span className="min-w-0 truncate">
                  {a.action} <span className="font-mono text-caption text-muted-foreground">{a.target}</span>
                </span>
                <code className="font-mono text-caption text-muted-foreground">{a.hash}</code>
              </li>
            ))}
          </ul>
        </div>
      </Section>
    </div>
  )
}
