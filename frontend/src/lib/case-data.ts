// Everything the case pages and the report need, read from the case's saved evidence.
// Nothing here is invented: a value the evidence does not hold stays null and the page says so.
// The pages and the report both go through this module so they cannot disagree about a number.
import { useEffect, useState } from "react"
import { api, type ApiAnalysis, type ApiImageFile, type CustodyChain } from "@/lib/api"
import { DEFAULT_TIME, utcMs, type TimeSettings } from "@/lib/time"

export type Kind = "live" | "deleted" | "unknown" | "excluded"

export interface CaseRecording {
  imageId: number
  imageName: string
  id: string
  channel: number | null
  start: string | null // as the recorder wrote it
  end: string | null
  startMs: number | null // UTC, after the image's time-zone and drift settings
  endMs: number | null
  kind: Kind
  adapter: string | null
  recovered: Extraction | null
}

export interface Extraction {
  gate: "passed" | "excluded" | null
  frames: number | null
  reason: string | null
  recoveredSha256: string | null // the recovered bytes, before any decode
  outputSha256: string | null // the decoded viewing copy
}

export interface LogEntry { imageName: string; when: string | null; whenMs: number | null; type: string; text: string }

export interface EvidenceItem {
  image: ApiImageFile
  md5: string | null
  sha256: string | null
  integrity: { matches: boolean | null; checkedAt: string | null } | null
  parsed: boolean
  identified: boolean
  family: string | null
  container: string | null
  adapter: string | null
  vendor: { brand: string | null; confidence: string | null; note: string | null; evidence: string[]; candidates: string[] } | null
  filesystems: string[]
  parser: { name: string; version: string } | null
  warnings: string[]
  knowledge: { label: string; status: string; observations: number; knowledgeDb: string } | null
  steps: string[]
  intake: { source: string | null; acquiredOn: string | null; timeZone: string | null; writeBlocker: boolean; notes: string } | null
  settings: TimeSettings
  timeSet: boolean // false when the examiner has not set a time zone or drift, so the default is in use
}

export interface CaseData {
  loading: boolean
  error: string
  images: ApiImageFile[]
  evidence: EvidenceItem[]
  parsed: ApiImageFile[] // images that have been parsed
  recordings: CaseRecording[]
  emptyEntries: number // index entries that point at no video
  logs: LogEntry[]
  analysis: ApiAnalysis[]
  vendors: { imageName: string; brand: string | null }[]
  custody: CustodyChain | null
}

const empty: CaseData = { loading: true, error: "", images: [], evidence: [], parsed: [], recordings: [], emptyEntries: 0, logs: [], analysis: [], vendors: [], custody: null }

const STEP_LABEL: Record<string, string> = {
  intake_hashes: "Hashed at intake (MD5, SHA-256)",
  intake_notes: "Handling details stated at intake",
  media_hashes: "Evidence re-hashed",
  identification: "Recorder format identified",
  parsed_bundle: "Index parsed",
  integrity: "Hash re-verified against intake",
  induction: "Header layout learned from the video",
  knowledge_match: "Layout compared with the knowledge base",
  time_settings: "Time zone and clock drift set",
}
export function stepLabels(dataTypes: string[]): string[] {
  const steps = dataTypes.filter((d) => STEP_LABEL[d]).map((d) => STEP_LABEL[d])
  const extracted = dataTypes.filter((d) => d.startsWith("extraction_")).length
  if (extracted) steps.push(`${extracted} recording(s) recovered and decode-checked`)
  return steps
}

export async function loadCaseData(caseId: string): Promise<CaseData> {
  const images = (await api.listImages(caseId)).data
  const evidence: EvidenceItem[] = [], recordings: CaseRecording[] = [], logs: LogEntry[] = [], parsed: ApiImageFile[] = []
  const vendors: CaseData["vendors"] = []
  let emptyEntries = 0
  for (const image of images) {
    const data: any = (await api.getForensics(image.id)).data
    const settings: TimeSettings = data.time_settings ?? DEFAULT_TIME
    const v = data.parsed_bundle?.vendor ?? data.vendor ?? data.identification?.vendor ?? null
    evidence.push({
      image, md5: data.intake_hashes?.md5 ?? null, sha256: data.intake_hashes?.sha256 ?? image.hash_sha256,
      integrity: data.integrity ? { matches: data.integrity.matches ?? null, checkedAt: data.integrity.checked_at ?? null } : null,
      parsed: !!data.parsed_bundle, identified: !!(data.identification ?? data.parsed_bundle?.identification),
      family: data.identification?.family ?? data.parsed_bundle?.identification?.family ?? null,
      container: data.identification?.container ?? data.parsed_bundle?.identification?.container ?? null,
      adapter: data.identification?.adapter ?? data.parsed_bundle?.identification?.adapter ?? null,
      vendor: v ? { brand: v.brand ?? null, confidence: v.confidence ?? null, note: v.note ?? null, evidence: v.evidence ?? [], candidates: v.candidates ?? [] } : null,
      filesystems: (data.parsed_bundle?.identification?.filesystems ?? []).map((f: any) => f.type ?? f.filesystem).filter(Boolean),
      parser: data.parsed_bundle?.parser ? { name: data.parsed_bundle.parser.name, version: data.parsed_bundle.parser.version } : null,
      warnings: data.parsed_bundle?.warnings ?? data.warnings ?? [],
      knowledge: data.knowledge_match ? { label: data.knowledge_match.label, status: data.knowledge_match.status, observations: data.knowledge_match.observations, knowledgeDb: data.knowledge_match.knowledge_db_version } : null,
      steps: stepLabels(Object.keys(data)), intake: data.intake_notes ?? null, settings, timeSet: !!data.time_settings,
    })
    if (!data.parsed_bundle) continue
    parsed.push(image)
    vendors.push({ imageName: image.filename, brand: v?.brand ?? null })
    for (const r of data.recordings ?? []) {
      if (r.state === "empty" || r.status === "No Video/Recording") { emptyEntries++; continue }
      const ex = data[`extraction_${r.id}`]
      const recovered: Extraction | null = ex ? {
        gate: ex.gate?.result ?? null, frames: ex.gate?.frames ?? null, reason: ex.gate?.reason ?? null,
        recoveredSha256: ex.recovered_sha256 ?? null, outputSha256: ex.hashes?.sha256 ?? null } : null
      recordings.push({
        imageId: image.id, imageName: image.filename, id: r.id, channel: r.channel ?? null, start: r.start ?? null, end: r.end ?? null,
        startMs: utcMs(r.start, settings), endMs: utcMs(r.end, settings), adapter: r.adapter ?? data.identification?.adapter ?? null, recovered,
        kind: recovered?.gate === "excluded" ? "excluded" : r.state === "live" ? "live" : r.state === "deleted" ? "deleted" : "unknown",
      })
    }
    for (const e of data.system_logs?.system_logs ?? [])
      logs.push({ imageName: image.filename, when: e.timestamp_readable ?? null, whenMs: utcMs(e.timestamp_readable, settings),
        type: e.log_type_name ?? "Log entry", text: e.description?.parsed_type ?? "" })
  }
  const analysis = (await api.analysis(caseId)).data
  const custody = await api.caseCustody(caseId).then((r) => r.data).catch(() => null)
  return { loading: false, error: "", images, evidence, parsed, recordings, emptyEntries, logs, analysis, vendors, custody }
}

export function useCaseData(caseId: string): CaseData {
  const [state, setState] = useState<CaseData>(empty)
  useEffect(() => {
    let live = true
    loadCaseData(caseId).then((d) => live && setState(d))
      .catch((e) => live && setState({ ...empty, loading: false, error: e instanceof Error ? e.message : String(e) }))
    return () => { live = false }
  }, [caseId])
  return state
}

/** "2026-09-14 02:11 UTC" or the same moment in IST. */
export function formatMs(ms: number, zone: "utc" | "ist"): string {
  const d = new Date(ms + (zone === "ist" ? 330 * 60000 : 0))
  return d.toISOString().slice(0, 16).replace("T", " ") + (zone === "ist" ? " IST" : " UTC")
}

export const channelName = (ch: number | null) => (ch == null ? "Channel unknown" : `Channel ${ch}`)

/** A camera is a channel of one recorder: channel 1 of two different evidence items are two different cameras. */
export const laneKey = (imageId: number, ch: number | null) => `${imageId}:${ch ?? "x"}`
export const laneLabel = (ch: number | null, imageName: string, many: boolean) => (many ? `${channelName(ch)} · ${imageName}` : channelName(ch))

// ---------------------------------------------------------------------------------------------- derived views

const GAP_MS = 2 * 60_000 // a pause shorter than this is normal segmenting, not missing footage

export interface Gap { key: string; label: string; from: number; to: number; logs: LogEntry[] }

/** What the disk shows about deleted footage. Observations only: no cause is inferred. */
export function deletionView(data: CaseData) {
  const timed = data.recordings.filter((r) => r.startMs !== null)
  const deleted = data.recordings.filter((r) => r.kind === "deleted")
  const live = data.recordings.filter((r) => r.kind === "live")
  const unknown = data.recordings.filter((r) => r.kind === "unknown")
  const span = (list: CaseRecording[]) => list.length ? { from: Math.min(...list.map((r) => r.startMs!)), to: Math.max(...list.map((r) => r.endMs ?? r.startMs!)) } : null
  const deletedSpan = span(deleted.filter((r) => r.startMs !== null)), liveSpan = span(live.filter((r) => r.startMs !== null))

  // Per camera, the stretches between one recording's end and the next one's start.
  const gaps: Gap[] = []
  const many = new Set(timed.map((r) => r.imageId)).size > 1
  for (const key of new Set(timed.map((r) => laneKey(r.imageId, r.channel)))) {
    const mine = timed.filter((r) => laneKey(r.imageId, r.channel) === key && r.endMs !== null).sort((a, b) => a.startMs! - b.startMs!)
    const own = data.logs.filter((l) => mine.length > 0 && l.imageName === mine[0].imageName) // a recorder's logs belong to it alone
    let reach = mine.length ? mine[0].endMs! : 0
    for (const r of mine.slice(1)) {
      if (r.startMs! - reach > GAP_MS)
        gaps.push({ key, label: laneLabel(mine[0].channel, mine[0].imageName, many), from: reach, to: r.startMs!, logs: own.filter((l) => l.whenMs !== null && l.whenMs >= reach && l.whenMs <= r.startMs!) })
      reach = Math.max(reach, r.endMs!)
    }
  }
  gaps.sort((a, b) => b.to - b.from - (a.to - a.from))

  const observations = [
    deleted.length && { obs: `${deleted.length} recording(s) are marked deleted and could be recovered from the disk`, infer: "They were removed from the recorder's index, but their data was still on the disk" },
    deletedSpan && liveSpan && deletedSpan.to < liveSpan.from && {
      obs: `Deleted footage ends ${formatMs(deletedSpan.to, "utc")}; live footage begins ${formatMs(liveSpan.from, "utc")}`,
      infer: "Footage between those times is not on the disk, or was overwritten" },
    deletedSpan && liveSpan && deletedSpan.to >= liveSpan.from && {
      obs: "Deleted and live footage cover overlapping times", infer: "Different channels or recording passes; look at the per-channel gaps" },
    unknown.length && { obs: `${unknown.length} recording(s) could not be classed as live or deleted`, infer: "This recorder's index does not say; they are shown dashed on the timeline" },
  ].filter(Boolean) as { obs: string; infer: string }[]

  return { deleted, live, unknown, deletedSpan, liveSpan, gaps, observations, logsParsed: data.logs.length > 0 }
}

/** Per camera: recordings that passed the quality gate, and how many of those any tool has looked at. */
export function coverageView(data: CaseData) {
  const usable = data.recordings.filter((r) => r.kind !== "excluded")
  const many = new Set(usable.map((r) => r.imageId)).size > 1
  return [...new Set(usable.map((r) => laneKey(r.imageId, r.channel)))].map((key) => {
    const mine = usable.filter((r) => laneKey(r.imageId, r.channel) === key)
    const done = mine.filter((r) => data.analysis.some((a) => a.imageFileId === r.imageId && a.recordingId === r.id))
    return { key, label: laneLabel(mine[0].channel, mine[0].imageName, many), total: mine.length, done: done.length, pct: Math.round((done.length / mine.length) * 100) }
  })
}

const VEHICLES = new Set(["car", "truck", "bus", "motorcycle", "bicycle", "train", "airplane", "boat"])
export const kindOf = (cls: string) => cls === "person" ? "person" : VEHICLES.has(cls) ? "vehicle" : cls

export interface Sighting { id: string; ch: number | null; lane: string; label: string; cls: string; kind: string; t: number; source: string }

/** Only a detection on a clip with a known channel and recording time can be placed against other cameras. */
export function sightings(data: CaseData) {
  const events: Sighting[] = []
  let skipped = 0
  const many = new Set(data.recordings.map((r) => r.imageId)).size > 1
  for (const run of data.analysis) {
    const rec = data.recordings.find((r) => r.imageId === run.imageFileId && r.id === run.recordingId)
    if (!rec || rec.startMs === null || rec.channel === null) { skipped += run.data.appearances.length; continue }
    run.data.appearances.forEach((a, i) => {
      const cls = a.class.toLowerCase()
      events.push({ id: `${run.id}-${i}`, ch: rec.channel, lane: laneKey(rec.imageId, rec.channel), label: laneLabel(rec.channel, rec.imageName, many), cls, kind: kindOf(cls), t: rec.startMs! + a.start_s * 1000, source: run.source })
    })
  }
  return { events: events.slice(0, 400), skipped }
}

/** Each sighting is linked to the nearest later sighting of the same kind on every other camera. */
export function pairUp(events: Sighting[], gapSeconds: number, kind = "all") {
  const lanes = [...new Set(events.map((e) => e.lane))]
  const out: { id: string; a: Sighting; b: Sighting; dt: number }[] = []
  for (const a of events) {
    if (kind !== "all" && a.kind !== kind) continue
    for (const lane of lanes) {
      if (lane === a.lane) continue
      let best: Sighting | null = null
      for (const b of events) if (b.lane === lane && b.kind === a.kind && b.t > a.t && (!best || b.t < best.t)) best = b
      if (best && (best.t - a.t) / 1000 <= gapSeconds) out.push({ id: a.id + "|" + best.id, a, b: best, dt: (best.t - a.t) / 1000 })
    }
  }
  return out.sort((x, y) => x.a.t - y.a.t).slice(0, 200)
}

/** Which clocks this case holds evidence from. Comparing them for disagreement is not automated. */
export function clockSources(data: CaseData, zone: "utc" | "ist") {
  const placed = data.recordings.filter((r) => r.startMs !== null)
  const logTimes = data.logs.map((l) => l.whenMs).filter((n): n is number => n !== null)
  return [
    { id: "W1", name: "Recorder clock", source: "Times stored in the recorder's own index or file names", independent: "reference", available: placed.length > 0,
      detail: placed.length ? `${placed.length} recording(s) timed` : "no recorder times found" },
    { id: "W2", name: "On-screen display", source: "Burned-in overlay read with OCR", independent: "Yes", available: false, detail: "OCR results are not kept per recording" },
    { id: "W3", name: "Recorder logs", source: "Time-set and NTP-sync events in the recorder's system log", independent: "No, same clock", available: data.logs.length > 0,
      detail: data.logs.length && logTimes.length ? `${data.logs.length} entries, ${formatMs(Math.min(...logTimes), zone)} to ${formatMs(Math.max(...logTimes), zone)}` : "no system log parsed" },
    { id: "W4", name: "Seizure anchor", source: "Photo of the recorder clock beside a reference time", independent: "Yes", available: false, detail: "not supported yet" },
    { id: "W5", name: "Scene events", source: "Sunrise, streetlight switching", independent: "Yes", available: false, detail: "not supported yet" },
  ]
}
