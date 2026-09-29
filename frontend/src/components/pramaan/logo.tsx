import { cn } from "@/lib/utils"

/** Pramaan's mark, as supplied by the product team. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <img
      src="/pramaan_logo.jpeg"
      alt="Pramaan"
      className={cn("size-8 shrink-0 rounded-[10px] object-cover", className)}
    />
  )
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("font-display text-[1.375rem] leading-none tracking-[-0.02em]", className)}>
      Pramaan
    </span>
  )
}
