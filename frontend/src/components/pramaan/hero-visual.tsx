import { CheckCircleIcon, ClockCountdownIcon, EraserIcon, FilmStripIcon } from "@phosphor-icons/react"
import { cn } from "@/lib/utils"

const chips = [
  { icon: CheckCircleIcon, label: "SHA-256 verified", tone: "success" as const, className: "-left-6 top-6 [animation-delay:0s]" },
  { icon: FilmStripIcon, label: "Recovered clip", tone: "secondary" as const, className: "-right-4 top-24 [animation-delay:0.6s]" },
  { icon: ClockCountdownIcon, label: "00:04:12 ±2s", tone: "primary" as const, className: "-left-2 bottom-20 [animation-delay:1.2s]" },
  { icon: EraserIcon, label: "Deletion traced", tone: "accent" as const, className: "-right-8 bottom-6 [animation-delay:1.8s]" },
]

const toneClasses = {
  success: "bg-success-soft text-success",
  secondary: "bg-secondary/15 text-secondary",
  primary: "bg-primary-soft text-primary-soft-foreground",
  accent: "bg-accent/20 text-accent-foreground",
}
const toneClassesInverted = {
  success: "bg-primary-foreground/20 text-primary-foreground",
  secondary: "bg-primary-foreground/20 text-primary-foreground",
  primary: "bg-primary-foreground/20 text-primary-foreground",
  accent: "bg-primary-foreground/20 text-primary-foreground",
}

/**
 * Abstract, hand-drawn scan/verify visual — no external imagery, built from theme tokens.
 * `inverted` swaps card/border surfaces for translucent white, for use on the primary panel.
 */
export function HeroVisual({ className, inverted = false }: { className?: string; inverted?: boolean }) {
  const tones = inverted ? toneClassesInverted : toneClasses
  return (
    <div className={cn("relative mx-auto flex size-72 items-center justify-center sm:size-88", className)}>
      <div className={cn("absolute inset-0 rounded-full border border-dashed animate-spin-slow", inverted ? "border-primary-foreground/25" : "border-primary/25")} />
      <div className={cn("absolute inset-6 rounded-full border border-dashed animate-spin-slow-reverse", inverted ? "border-primary-foreground/25" : "border-secondary/30")} />

      <div className={cn("absolute inset-14 overflow-hidden rounded-full", inverted ? "bg-primary-foreground/10" : "bg-card smooth-shadow-ring-lg")}>
        <div
          aria-hidden="true"
          className={cn("pointer-events-none absolute inset-x-0 h-16 animate-scan-line bg-gradient-to-b to-transparent", inverted ? "from-primary-foreground/30" : "from-primary/25")}
        />
        <div className="absolute inset-0 flex items-center justify-center">
          <span className={cn("absolute size-16 rounded-full animate-pulse-ring", inverted ? "bg-primary-foreground/25" : "bg-primary/25")} />
          <span className={cn("absolute size-16 rounded-full animate-pulse-ring [animation-delay:1.4s]", inverted ? "bg-primary-foreground/25" : "bg-primary/25")} />
          <div className={cn("relative flex size-16 items-center justify-center rounded-full", inverted ? "bg-primary-foreground text-primary" : "bg-primary text-primary-foreground")}>
            <svg viewBox="0 0 24 24" className="size-7" fill="none" aria-hidden="true">
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
              <circle cx="12" cy="12" r="2.5" fill="currentColor" />
            </svg>
          </div>
        </div>
      </div>

      {chips.map((chip) => (
        <div
          key={chip.label}
          className={cn(
            "absolute flex items-center gap-2 rounded-full py-1.5 pl-2 pr-3 text-caption font-medium animate-float",
            inverted ? "border border-primary-foreground/20 bg-primary-foreground/10 text-primary-foreground" : "border border-hairline bg-card smooth-shadow-ring-lg",
            chip.className
          )}
        >
          <span className={cn("flex size-6 items-center justify-center rounded-full", tones[chip.tone])}>
            <chip.icon className="size-3.5" weight={chip.tone === "success" ? "fill" : "regular"} />
          </span>
          {chip.label}
        </div>
      ))}
    </div>
  )
}
