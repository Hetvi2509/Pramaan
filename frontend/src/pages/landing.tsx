import { Link } from "react-router-dom"
import {
  ArrowRightIcon,
  EraserIcon,
  EyeIcon,
  FilmStripIcon,
  FingerprintIcon,
  GavelIcon,
  HardDrivesIcon,
  ListChecksIcon,
  ScanIcon,
  ShieldCheckIcon,
  UsbIcon,
} from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { LogoMark, Wordmark } from "@/components/pramaan/logo"
import { HeroVisual } from "@/components/pramaan/hero-visual"
import { useInView } from "@/hooks/use-in-view"
import { cn } from "@/lib/utils"

const features = [
  {
    icon: UsbIcon,
    title: "Hashed on intake",
    desc: "Add a DVR/NVR disk image taken behind a write-blocker. It is hashed on the way in and re-checked before use.",
  },
  {
    icon: FilmStripIcon,
    title: "Recovery, with a quality gate",
    desc: "Carve recoverable clips and know which ones actually pass verification.",
  },
  {
    icon: EraserIcon,
    title: "Deletion, explained",
    desc: "See how footage went missing, not just that it did.",
  },
  {
    icon: ScanIcon,
    title: "Motion, OCR, faces, objects",
    desc: "Run detections across every clip and correlate events across cameras.",
  },
  {
    icon: FingerprintIcon,
    title: "Chain of custody",
    desc: "Every action hashed, timestamped and logged to an audit trail.",
  },
  {
    icon: ListChecksIcon,
    title: "Court-ready reporting",
    desc: "Export a report with a Section 63 certificate, provenance intact.",
  },
]

const stats = [
  { value: "100%", label: "offline, air-gapped capable" },
  { value: "SHA-256", label: "hashed at every stage" },
  { value: "Sec. 65B/63", label: "certificate-ready export" },
]

const pillars = [
  {
    icon: EyeIcon,
    title: "Nothing skipped silently",
    desc: "Every stage that could fail says so. Uncertain results are shown as uncertain, not rounded off to look clean.",
  },
  {
    icon: FingerprintIcon,
    title: "Provenance over convenience",
    desc: "Every hash, timestamp and action is logged. The report traces back to the original disk image, not a summary of it.",
  },
  {
    icon: GavelIcon,
    title: "Built for the evidence chain",
    desc: "Designed around how DVR/NVR evidence actually gets challenged in court, from acquisition to Section 63 certification.",
  },
]

function FeatureCard({ f, index }: { f: (typeof features)[number]; index: number }) {
  const { ref, inView } = useInView<HTMLDivElement>()
  return (
    <div
      ref={ref}
      className={cn(
        inView
          ? "animate-in fade-in slide-in-from-bottom-6 fill-mode-forwards duration-700 ease-(--ease-out)"
          : "opacity-0"
      )}
      style={{ animationDelay: `${(index % 3) * 90}ms` }}
    >
      <Card className="h-full border-hairline transition-shadow duration-150 ease-(--ease-ui) hover:smooth-shadow-ring-lg">
        <CardContent className="flex flex-col gap-3">
          <div className="flex size-10 items-center justify-center rounded-md bg-primary-soft text-primary-soft-foreground">
            <f.icon className="size-5" />
          </div>
          <div className="space-y-1">
            <h3 className="font-display text-heading">{f.title}</h3>
            <p className="text-body text-muted-foreground">{f.desc}</p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function AboutSection() {
  const { ref, inView } = useInView<HTMLDivElement>()
  return (
    <section className="border-t border-hairline bg-card/60 py-24">
      <div ref={ref} className="mx-auto w-full max-w-[1200px] px-6 sm:px-10">
        <div
          className={cn(
            "max-w-2xl",
            inView ? "animate-in fade-in slide-in-from-bottom-6 fill-mode-forwards duration-700 ease-(--ease-out)" : "opacity-0"
          )}
        >
          <span className="text-eyebrow uppercase tracking-(--text-eyebrow--letter-spacing) text-muted-foreground">About us</span>
          <h2 className="mt-3 font-display text-title text-balance">Built because deleted footage still needs to hold up in court.</h2>
          <p className="mt-4 text-body text-muted-foreground">
            Pramaan is an offline forensic workstation for DVR and NVR storage: acquisition, recovery, deletion analysis and
            reporting in one chain, so an investigator can go from a seized disk to a Section 65B/63-certified report without the
            evidence ever leaving the lab.
          </p>
        </div>

        <div className="mt-14 grid grid-cols-1 gap-8 sm:grid-cols-3">
          {pillars.map((p, i) => (
            <div
              key={p.title}
              className={cn(
                inView ? "animate-in fade-in slide-in-from-bottom-6 fill-mode-forwards duration-700 ease-(--ease-out)" : "opacity-0"
              )}
              style={{ animationDelay: inView ? `${120 + i * 100}ms` : undefined }}
            >
              <div className="flex size-10 items-center justify-center rounded-md bg-primary-soft text-primary-soft-foreground">
                <p.icon className="size-5" />
              </div>
              <h3 className="mt-4 font-display text-heading">{p.title}</h3>
              <p className="mt-1.5 text-body text-muted-foreground">{p.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

export default function LandingPage() {
  return (
    <div className="overflow-x-hidden">
      <section className="flex min-h-svh flex-col">
        <header className="animate-in fade-in slide-in-from-top-4 duration-700 ease-(--ease-out) mx-auto flex w-full max-w-[1200px] items-center justify-between px-6 py-6 sm:px-10">
          <div className="flex items-center gap-2.5">
            <LogoMark />
            <Wordmark />
          </div>
          <Button asChild variant="outline">
            <Link to="/login">Sign in</Link>
          </Button>
        </header>

        <div className="mx-auto grid w-full max-w-[1200px] flex-1 grid-cols-1 items-center gap-12 px-6 py-10 sm:px-10 lg:grid-cols-[1.1fr_0.9fr] lg:gap-8">
          <div className="flex flex-col items-start gap-6">
            <div className="animate-in fade-in slide-in-from-bottom-4 duration-700 ease-(--ease-out) inline-flex items-center gap-1.5 rounded-full border border-hairline bg-card px-3 py-1 text-caption text-muted-foreground">
              <ShieldCheckIcon weight="fill" className="size-3.5 text-success" />
              Runs fully offline, no cloud dependency
            </div>
            <h1 className="animate-in fade-in slide-in-from-bottom-4 duration-700 [animation-delay:100ms] fill-mode-backwards ease-(--ease-out) max-w-2xl font-display text-display text-balance">
              Forensic analysis of DVR and NVR disks, built for the courtroom.
            </h1>
            <p className="animate-in fade-in slide-in-from-bottom-4 duration-700 [animation-delay:180ms] fill-mode-backwards ease-(--ease-out) max-w-xl text-heading text-muted-foreground">
              Acquire, recover and analyse CCTV storage with a documented, hash-verified chain of custody from disk to report.
            </p>
            <div className="animate-in fade-in slide-in-from-bottom-4 duration-700 [animation-delay:260ms] fill-mode-backwards ease-(--ease-out) flex items-center gap-3 pt-2">
              <Button asChild size="lg">
                <Link to="/login">
                  Sign in <ArrowRightIcon />
                </Link>
              </Button>
              <Button asChild size="lg" variant="ghost">
                <Link to="/login?tab=signup">Create an account</Link>
              </Button>
            </div>

            <dl className="animate-in fade-in slide-in-from-bottom-4 duration-700 [animation-delay:340ms] fill-mode-backwards ease-(--ease-out) grid grid-cols-3 gap-6 pt-8">
              {stats.map((s) => (
                <div key={s.label}>
                  <dt className="font-display text-heading tnum">{s.value}</dt>
                  <dd className="text-caption text-muted-foreground">{s.label}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="animate-in fade-in zoom-in-95 duration-1000 [animation-delay:200ms] fill-mode-backwards ease-(--ease-out)">
            <HeroVisual />
          </div>
        </div>
      </section>

      <main className="mx-auto w-full max-w-[1200px] px-6 sm:px-10">
        <section className="grid grid-cols-1 gap-5 py-28 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f, i) => (
            <FeatureCard key={f.title} f={f} index={i} />
          ))}
        </section>
      </main>

      <AboutSection />

      <footer className="border-t border-hairline">
        <div className="mx-auto flex w-full max-w-[1200px] items-center justify-between px-6 py-6 text-caption text-muted-foreground sm:px-10">
          <span className="flex items-center gap-2">
            <HardDrivesIcon className="size-4" /> Pramaan
          </span>
          <span>Offline forensic workstation</span>
        </div>
      </footer>
    </div>
  )
}
