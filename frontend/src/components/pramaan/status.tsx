import { CheckCircleIcon, WarningIcon, CircleNotchIcon, CircleDashedIcon } from "@phosphor-icons/react"
import { Badge } from "@/components/ui/badge"
import type { CaseStage, FootageStatus } from "@/lib/mock"
import { cn } from "@/lib/utils"

const stageTone: Record<CaseStage, "neutral" | "primary" | "success" | "warning"> = {
  Intake: "neutral",
  Parsing: "primary",
  Recovering: "primary",
  Analysing: "primary",
  "Report ready": "success",
  Sealed: "neutral",
}

export function StageBadge({ stage }: { stage: CaseStage }) {
  return <Badge variant={stageTone[stage]}>{stage}</Badge>
}

/** One colour, one meaning: teal = live, amber = deleted, indigo = repaired, grey = excluded. */
export const footageSwatch: Record<FootageStatus, string> = {
  live: "bg-secondary",
  deleted: "bg-accent",
  repaired: "bg-primary",
  excluded: "bg-muted-foreground/40",
}

export function FootageDot({ status, className }: { status: FootageStatus; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-2.5 rounded-full", footageSwatch[status], className)} />
}

export function StepIcon({ state }: { state: "done" | "active" | "todo" | "attention" }) {
  const c = "size-5 shrink-0"
  if (state === "done") return <CheckCircleIcon weight="fill" className={cn(c, "text-success")} aria-label="Done" />
  if (state === "attention") return <WarningIcon weight="fill" className={cn(c, "text-warning")} aria-label="Needs attention" />
  if (state === "active") return <CircleNotchIcon weight="bold" className={cn(c, "text-primary")} aria-label="In progress" />
  return <CircleDashedIcon className={cn(c, "text-muted-foreground/60")} aria-label="Not started" />
}
