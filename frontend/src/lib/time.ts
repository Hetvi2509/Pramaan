// Recorder clocks are stored as local wall-clock text. The raw text is never changed; UTC is derived from it.
export type TimeSettings = { tzMinutes: number; driftSeconds: number }
export const DEFAULT_TIME: TimeSettings = { tzMinutes: 330, driftSeconds: 0 } // IST, recorder assumed accurate

/** UTC for a recorder-clock string, or null when it carries no readable "YYYY-MM-DD HH:MM:SS". */
export function toUtc(raw: string | null | undefined, { tzMinutes, driftSeconds }: TimeSettings): string | null {
  const m = raw?.match(/(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)/)
  if (!m) return null
  const local = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
  // true local time = recorder time - drift; UTC = true local time - offset
  return new Date(local - driftSeconds * 1000 - tzMinutes * 60000).toISOString().replace("T", " ").slice(0, 19) + " UTC"
}

export const tzLabel = (min: number) => `UTC${min < 0 ? "-" : "+"}${String(Math.floor(Math.abs(min) / 60)).padStart(2, "0")}:${String(Math.abs(min) % 60).padStart(2, "0")}`
export const TIMEZONES = [-480, -420, -360, -300, -240, 0, 60, 120, 180, 240, 270, 330, 345, 480, 540, 600]

/** Same conversion as toUtc, as milliseconds since the epoch, for placing things on a shared axis. */
export function utcMs(raw: string | null | undefined, { tzMinutes, driftSeconds }: TimeSettings): number | null {
  const m = raw?.match(/(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)/)
  if (!m) return null
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - driftSeconds * 1000 - tzMinutes * 60000
}
