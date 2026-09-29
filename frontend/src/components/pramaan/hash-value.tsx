import { CopyButton } from "@/components/pramaan/copy-button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

/** Hashes are evidence: show enough to eyeball, keep the full value one hover away. */
export function HashValue({ value, label, full = false }: { value: string; label: string; full?: boolean }) {
  const shown = full ? value : `${value.slice(0, 10)}…${value.slice(-8)}`
  return (
    <span className="inline-flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <code className="rounded-sm font-mono text-caption tracking-tight text-foreground">{shown}</code>
        </TooltipTrigger>
        {!full && <TooltipContent className="max-w-none font-mono">{value}</TooltipContent>}
      </Tooltip>
      <CopyButton value={value} label={label} />
    </span>
  )
}
