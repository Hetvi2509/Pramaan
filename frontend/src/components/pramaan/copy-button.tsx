import { useState } from "react"
import { CheckIcon, CopyIcon } from "@phosphor-icons/react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

// Icon swap: scale 0.25 to 1, opacity 0 to 1, blur 4px to 0, cubic-bezier(0.2, 0, 0, 1).
const swap =
  "absolute inset-0 m-auto transition-[opacity,scale,filter] duration-200 ease-(--ease-ui)"
const hidden = "scale-[0.25] opacity-0 blur-[4px]"
const shown = "scale-100 opacity-100 blur-0"

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false)

  async function copy() {
    await navigator.clipboard.writeText(value)
    setDone(true)
    toast.success(`${label} copied`)
    setTimeout(() => setDone(false), 1400)
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Copy ${label}`}
          onClick={copy}
          className="relative text-muted-foreground hover:text-foreground"
        >
          <CopyIcon className={`${swap} size-3.5 ${done ? hidden : shown}`} />
          <CheckIcon weight="bold" className={`${swap} size-3.5 text-success ${done ? shown : hidden}`} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Copy {label}</TooltipContent>
    </Tooltip>
  )
}
