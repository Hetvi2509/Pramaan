import { CalendarBlankIcon } from "@phosphor-icons/react"
import { format } from "date-fns"
import type { DateRange } from "react-day-picker"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

// Recorders go back years; year and month are shadcn Selects inside the calendar.
const start = new Date(2005, 0)
const end = new Date(2030, 11)

const trigger =
  "h-10 justify-start gap-2.5 px-3.5 font-normal border-input data-[empty=true]:text-muted-foreground"

export function DatePicker({
  value,
  onChange,
  placeholder = "Pick a date",
  className,
}: {
  value?: Date
  onChange: (d?: Date) => void
  placeholder?: string
  className?: string
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" data-empty={!value} className={cn(trigger, className)}>
          <CalendarBlankIcon className="text-muted-foreground" />
          <span className="tnum">{value ? format(value, "dd MMM yyyy") : placeholder}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={value}
          onSelect={onChange}
          defaultMonth={value}
          captionLayout="dropdown"
          startMonth={start}
          endMonth={end}
        />
      </PopoverContent>
    </Popover>
  )
}

export function DateRangePicker({
  value,
  onChange,
  placeholder = "Any date",
  className,
}: {
  value?: DateRange
  onChange: (r?: DateRange) => void
  placeholder?: string
  className?: string
}) {
  const label = value?.from
    ? value.to
      ? `${format(value.from, "dd MMM")} – ${format(value.to, "dd MMM yyyy")}`
      : format(value.from, "dd MMM yyyy")
    : placeholder
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" data-empty={!value?.from} className={cn(trigger, className)}>
          <CalendarBlankIcon className="text-muted-foreground" />
          <span className="tnum">{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="range"
          selected={value}
          onSelect={onChange}
          numberOfMonths={2}
          captionLayout="dropdown"
          startMonth={start}
          endMonth={end}
          defaultMonth={value?.from}
        />
      </PopoverContent>
    </Popover>
  )
}
