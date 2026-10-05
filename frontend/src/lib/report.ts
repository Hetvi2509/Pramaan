// Builds the report document (HTML for print-to-PDF, plus JSON) from the case's saved evidence.
// Every figure comes from lib/case-data.ts, the same source the pages read. Nothing is filled in as a
// placeholder: a section with nothing to report says so. No PDF library: the browser's print-to-PDF
// produces the file, so layout is plain CSS and stays fully under our control.
import { format } from "date-fns"
import type { ApiCase } from "@/lib/api"
import { tzLabel } from "@/lib/time"
import { channelName, clockSources, coverageView, deletionView, formatMs, pairUp, sightings, type CaseData, type EvidenceItem } from "@/lib/case-data"

export interface ReportSection {
  name: string
  ready: boolean
  note?: string
}

export interface ReportData {
  generatedAt: Date
  generatedBy: string
  caseInfo: { id: string; title: string; station: string; examiner: string; opened: string }
  evidence: EvidenceItem[]
  recordings: { evidence: string; channel: string; state: string; recorderStart: string | null; recorderEnd: string | null; startUtc: string | null; endUtc: string | null
    gate: string; frames: number | null; recoveredSha256: string | null; viewingCopySha256: string | null }[]
  deletion: { counts: { deleted: number; live: number; unknown: number }; deletedPeriod: string | null; observations: { obs: string; infer: string }[]
    gaps: { camera: string; from: string; to: string; logEntries: string }[]; logsParsed: boolean }
  analysis: { tool: string; clip: string; camera: string; at: string; finding: string; confidence: string }[]
  coverage: { camera: string; analysed: number; total: number }[]
  pairs: { first: string; then: string; kind: string; gapSeconds: number }[]
  clockSources: { id: string; name: string; source: string; available: boolean; detail: string }[]
  sections: ReportSection[]
  limitations: string[]
  certificate: { part: "a" | "b"; expertName: string }
}

const VALIDATION: Record<string, string> = {
  hikvision: "Parsed with Pramaan's Hikvision layout parser, tested on a synthetic image.",
  dhfs: "Parsed with a Dahua DHFS layout parser implemented from a third-party description and tested only on synthetic images.",
  honeywell: "Parsed with a Honeywell layout parser implemented from a published paper and tested only on synthetic images.",
  uniview: "Parsed with a Uniview layout parser implemented from a third-party description and tested only on synthetic images.",
  godrej: "Parsed with a Qualvision QVFS layout parser implemented from a third-party description and tested only on synthetic images.",
  tplink: "Parsed with a TP-Link layout parser implemented from a third-party description and tested only on synthetic images.",
  dhav: "Read as a DHAV record stream; no disk filesystem or deleted-video parser was involved.",
  media: "Read as a standard playable video file or container.",
  filesystem: "Read through the filesystem found on the image; footage whose directory entry was removed was carved by video syntax.",
}

export function computeSections(data: CaseData): ReportSection[] {
  const { images, evidence, recordings, analysis } = data
  const timed = recordings.filter((r) => r.startMs !== null)
  const recovered = recordings.filter((r) => r.recovered)
  const unparsed = evidence.filter((e) => !e.parsed)
  const clocks = clockSources(data, "utc")
  const missingClocks = clocks.filter((c) => !c.available)
  const coverage = coverageView(data).filter((c) => c.done < c.total)
  const d = deletionView(data)
  return [
    { name: "Case and examiner", ready: true },
    { name: "Device identification", ready: evidence.length > 0 && evidence.every((e) => e.identified || e.parsed),
      note: !evidence.length ? "No evidence added to this case yet" : unparsed.length ? `${unparsed.length} evidence item(s) not identified or parsed` : undefined },
    { name: "Acquisition and hashes", ready: images.length > 0 && images.every((i) => !!i.hash_sha256), note: images.length === 0 ? "No evidence added to this case yet" : undefined },
    { name: "Methods and parser versions", ready: evidence.some((e) => e.parsed), note: evidence.some((e) => e.parsed) ? undefined : "Nothing has been parsed yet" },
    { name: "Recovered footage", ready: recovered.length > 0, note: recovered.length ? undefined : "No recording has been recovered yet" },
    { name: "Deletion findings", ready: evidence.some((e) => e.parsed), note: d.deleted.length ? undefined : "No deleted footage found, or nothing parsed yet" },
    { name: "Timeline with uncertainty", ready: timed.length > 0 && missingClocks.length === 0,
      note: !timed.length ? "No recording has a readable recorder time" : missingClocks.length ? `${missingClocks.length} of ${clocks.length} clock sources not available (${missingClocks.map((c) => c.id).join(", ")})` : undefined },
    { name: "Analytics leads and unchecked recordings", ready: analysis.length > 0 && coverage.length === 0,
      note: !analysis.length ? "No analysis has been run" : coverage.length ? `Analysis has not covered every recording on ${coverage.map((c) => c.label).join(", ")}` : undefined },
    { name: "Limitations", ready: true },
  ]
}

export function buildReportData(
  caseInfo: ApiCase | null,
  caseId: string,
  data: CaseData,
  certificate: { part: "a" | "b"; expertName: string },
  generatedBy: string,
): ReportData {
  const c = { id: String(caseInfo?.id ?? caseId), title: caseInfo?.name ?? `Case ${caseId}`, station: caseInfo?.description ?? "Not set", examiner: generatedBy, opened: caseInfo?.created_at ?? new Date().toISOString() }
  const sections = computeSections(data)
  const deletion = deletionView(data)
  const { events } = sightings(data)
  const clocks = clockSources(data, "utc")

  const recordings = data.recordings.map((r) => ({
    evidence: r.imageName, channel: channelName(r.channel), state: r.kind === "unknown" ? "live or deleted not known" : r.kind,
    recorderStart: r.start, recorderEnd: r.end, startUtc: r.startMs !== null ? formatMs(r.startMs, "utc") : null, endUtc: r.endMs !== null ? formatMs(r.endMs, "utc") : null,
    gate: r.recovered?.gate ?? "not recovered", frames: r.recovered?.frames ?? null, recoveredSha256: r.recovered?.recoveredSha256 ?? null, viewingCopySha256: r.recovered?.outputSha256 ?? null,
  }))

  const analysis = data.analysis.flatMap((run) => {
    const rec = data.recordings.find((r) => r.imageId === run.imageFileId && r.id === run.recordingId)
    const camera = run.channel != null || rec ? channelName(run.channel) : "uploaded file, camera unknown"
    const rows = run.data.appearances.length ? run.data.appearances : [null]
    return rows.map((a) => ({
      tool: run.kind, clip: run.source, camera,
      at: a === null ? "whole clip" : rec?.startMs != null ? formatMs(rec.startMs + a.start_s * 1000, "utc") : `${a.start_s.toFixed(1)} s into the clip (recording time unknown)`,
      finding: a === null ? (run.kind === "faces" ? "Face leads: annotated video written, no list kept" : "No findings") : a.class,
      confidence: a?.confidence != null ? `${Math.round(a.confidence * 100)}%` : "—",
    }))
  })

  const limitations = [
    "Absolute times are the recorder's own clock moved to UTC using the time zone and clock drift set for each evidence item (default India time, no drift). No independent clock has been compared against them.",
    ...clocks.filter((k) => !k.available).map((k) => `Clock source ${k.id} (${k.name}) is not available for this case: ${k.detail}.`),
    "Pramaan lists what the disk holds. It does not determine whether footage was formatted, expired or overwritten.",
    "Solid-state recorders can erase deleted data on their own (TRIM, wear levelling). An image does not say whether the source drive was solid-state, so missing footage is not proof it was never recorded.",
    ...data.evidence.filter((e) => e.adapter && VALIDATION[e.adapter]).map((e) => `${e.image.filename}: ${VALIDATION[e.adapter!]}`),
    ...data.evidence.flatMap((e) => (e.vendor?.note ? [`${e.image.filename}: ${e.vendor.note}`] : [])),
    ...data.evidence.flatMap((e) => e.warnings.map((w) => `${e.image.filename}: ${w}`)),
    ...(data.analysis.some((a) => a.kind === "faces") ? ["Face detection output is a lead for an examiner to watch. It is never an identification."] : []),
    ...(data.analysis.length ? ["Object and motion detections are automatic and can be wrong; each should be confirmed by watching the clip."] : []),
    ...sections.filter((s) => !s.ready).map((s) => `${s.name}: ${s.note ?? "not yet complete"}.`),
  ]

  return {
    generatedAt: new Date(), generatedBy, caseInfo: c, evidence: data.evidence, recordings,
    deletion: {
      counts: { deleted: deletion.deleted.length, live: deletion.live.length, unknown: deletion.unknown.length },
      deletedPeriod: deletion.deletedSpan ? `${formatMs(deletion.deletedSpan.from, "utc")} to ${formatMs(deletion.deletedSpan.to, "utc")}` : null,
      observations: deletion.observations,
      gaps: deletion.gaps.slice(0, 50).map((g) => ({ camera: g.label, from: formatMs(g.from, "utc"), to: formatMs(g.to, "utc"),
        logEntries: !deletion.logsParsed ? "no system log to compare" : g.logs.length ? [...new Set(g.logs.map((l) => l.type))].join("; ") : "none" })),
      logsParsed: deletion.logsParsed,
    },
    analysis,
    coverage: coverageView(data).map((v) => ({ camera: v.label, analysed: v.done, total: v.total })),
    pairs: pairUp(events, 120).slice(0, 100).map((p) => ({ first: `${p.a.label}, ${formatMs(p.a.t, "utc")}`, then: `${p.b.label}, ${formatMs(p.b.t, "utc")}`, kind: p.a.kind, gapSeconds: Math.round(p.dt) })),
    clockSources: clocks.map(({ id, name, source, available, detail }) => ({ id, name, source, available, detail })),
    sections, limitations, certificate,
  }
}

/** SHA-256 of the report's own content, so a reader can tell the document wasn't altered after export. */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("")
}

function fmtSize(bytes: number | null) {
  if (!bytes) return "—"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let n = bytes
  let i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(n < 10 && i > 0 ? 2 : 0)} ${units[i]}`
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
}

const SOURCE_LABEL: Record<string, string> = { e01: "Expert Witness image (.E01)", dd: "raw image", file: "video file or other export" }
const none = (cols: number, text: string) => `<tr><td colspan="${cols}" class="muted">${esc(text)}</td></tr>`
const MAX_ROWS = 500

export function renderReportHtml(data: ReportData, formats: string[], reportHash: string): string {
  const { caseInfo: c, evidence, sections, certificate } = data
  const includeS63 = formats.includes("s63")
  const genDate = format(data.generatedAt, "d MMMM yyyy, HH:mm")

  const evidenceRows = evidence.length
    ? evidence.map((e) => `
      <tr>
        <td>EV-${e.image.id}</td>
        <td>${esc(e.image.filename)}</td>
        <td class="num">${fmtSize(e.image.size_bytes)}</td>
        <td class="mono">${e.sha256 ?? "pending"}${e.md5 ? `<br/>MD5 ${e.md5}` : ""}</td>
        <td class="num">${format(new Date(e.image.created_at), "d MMM yyyy, HH:mm")}</td>
        <td>${e.integrity === null ? '<span class="muted">not re-checked</span>' : e.integrity.matches === true ? "matches intake" : e.integrity.matches === false ? "<strong>DOES NOT MATCH intake</strong>" : "no intake hash to compare"}</td>
        <td>${e.intake ? [e.intake.source && `Source: ${SOURCE_LABEL[e.intake.source] ?? e.intake.source}`, e.intake.acquiredOn && `Acquired ${e.intake.acquiredOn}`,
          `Write-blocker: ${e.intake.writeBlocker ? "stated as used" : "not stated"}`, e.intake.notes && `Notes: ${e.intake.notes}`].filter(Boolean).map((t) => esc(String(t))).join("<br/>") : '<span class="muted">none recorded</span>'}</td>
      </tr>`).join("")
    : none(7, "No evidence has been added to this case yet.")

  const deviceRows = evidence.length ? evidence.map((e) => `
      <tr>
        <td>EV-${e.image.id} · ${esc(e.image.filename)}</td>
        <td>${esc(e.vendor?.brand ?? "Not determined")}${e.vendor?.confidence ? `<br/><span class="muted">${esc(e.vendor.confidence)}</span>` : ""}</td>
        <td>${esc([e.family, e.container, e.adapter].filter(Boolean).join(" · ") || "—")}</td>
        <td>${e.vendor?.evidence.length ? e.vendor.evidence.map(esc).join("<br/>") : '<span class="muted">no signature evidence</span>'}</td>
      </tr>`).join("") : none(4, "No evidence has been added to this case yet.")

  const methodRows = evidence.some((e) => e.steps.length || e.parser) ? evidence.map((e) => `
      <tr>
        <td>EV-${e.image.id} · ${esc(e.image.filename)}</td>
        <td>${e.steps.length ? e.steps.map(esc).join("<br/>") : '<span class="muted">No analysis run yet</span>'}<br/><span class="muted">Recorder time read as ${tzLabel(e.settings.tzMinutes)}, drift ${e.settings.driftSeconds} s</span></td>
        <td class="mono">${e.parser ? `${esc(e.parser.name)} ${esc(e.parser.version)}` : "—"}${e.knowledge ? `<br/>knowledge base ${esc(e.knowledge.knowledgeDb)}<br/>layout recorded as ${esc(e.knowledge.label)} (${esc(e.knowledge.status.toLowerCase())})` : ""}</td>
      </tr>`).join("") : ""

  const shown = data.recordings.slice(0, MAX_ROWS)
  const recordingRows = data.recordings.length ? shown.map((r) => `
      <tr>
        <td>${esc(r.evidence)}</td>
        <td>${esc(r.channel)}</td>
        <td>${esc(r.state)}</td>
        <td class="num">${r.startUtc ? esc(r.startUtc) : "no readable time"}${r.endUtc && r.endUtc !== r.startUtc ? `<br/>to ${esc(r.endUtc)}` : ""}${r.recorderStart ? `<br/><span class="muted">recorder: ${esc(r.recorderStart)}</span>` : ""}</td>
        <td>${esc(r.gate)}${r.frames != null ? ` (${r.frames} frames)` : ""}</td>
        <td class="mono">${r.recoveredSha256 ? `bytes ${r.recoveredSha256}` : "—"}${r.viewingCopySha256 ? `<br/>viewing copy ${r.viewingCopySha256}` : ""}</td>
      </tr>`).join("") + (data.recordings.length > MAX_ROWS ? none(6, `Showing the first ${MAX_ROWS} of ${data.recordings.length} recordings. The JSON export lists all of them.`) : "")
    : none(6, "No recordings were found in the parsed evidence.")

  const d = data.deletion
  const observations = d.observations.length ? d.observations.map((o) => `<li><strong>${esc(o.obs)}</strong> — ${esc(o.infer)}</li>`).join("") : '<li class="muted">No deleted footage was found in the parsed evidence.</li>'
  const gapRows = d.gaps.length ? d.gaps.map((g) => `
    <tr><td>${esc(g.camera)}</td><td class="num">${esc(g.from)} to ${esc(g.to)}</td><td>${esc(g.logEntries)}</td></tr>`).join("")
    : none(3, "No camera has a gap longer than two minutes between its recordings.")

  const analysisRows = data.analysis.length ? data.analysis.slice(0, MAX_ROWS).map((a) => `
    <tr><td>${esc(a.finding)}</td><td>${esc(a.tool)}</td><td>${esc(a.camera)}</td><td class="num">${esc(a.at)}</td><td class="num">${esc(a.confidence)}</td><td class="mono">${esc(a.clip)}</td></tr>`).join("")
    : none(6, "No analysis has been run in this case.")
  const coverageRows = data.coverage.length ? data.coverage.map((v) => `
    <tr><td>${esc(v.camera)}</td><td class="num">${v.analysed} of ${v.total}</td></tr>`).join("") : none(2, "No recordings.")
  const pairRows = data.pairs.length ? data.pairs.map((p) => `
    <tr><td>${esc(p.first)}</td><td>${esc(p.then)}</td><td>${esc(p.kind)}</td><td class="num">${p.gapSeconds} s</td></tr>`).join("")
    : none(4, "No sightings on different cameras fall within two minutes of each other (or none have a known recording time).")
  const clockRows = data.clockSources.map((w) => `
    <tr><td>${esc(w.id)} — ${esc(w.name)}</td><td>${esc(w.source)}</td><td>${esc(w.detail)}</td><td class="num">${w.available ? "Available" : "Not available"}</td></tr>`).join("")
  const sectionRows = sections.map((s) => `
    <tr><td>${esc(s.name)}</td><td class="num">${s.ready ? "Ready" : "Open"}</td><td>${s.note ? esc(s.note) : ""}</td></tr>`).join("")
  const limitationsList = data.limitations.map((t) => `<li>${esc(t)}</li>`).join("")

  const certificateBlock = includeS63 ? `
    <section class="sheet-section">
      <h2>Certificate under BSA 2023, Section 63(4)</h2>
      <p>${certificate.part === "a" ? "Part A — certified by the party producing the evidence." : "Part B — certified by the forensic expert who conducted the examination."}</p>
      <table class="kv">
        <tr><th>Certifying expert</th><td>${esc(certificate.expertName || "—")}</td></tr>
        <tr><th>Case reference</th><td>${esc(c.id)}</td></tr>
        <tr><th>Statement</th><td>To the best of my knowledge and belief, the electronic record described in this report was produced by the device identified above, and this document accurately and completely describes the manner in which it was examined.</td></tr>
      </table>
      <div class="signoff">
        <div><span class="line"></span><p>Signature</p></div>
        <div><span class="line"></span><p>Date</p></div>
      </div>
    </section>` : ""

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Report — ${esc(c.id)}</title>
<style>
  @page { size: A4; margin: 20mm 16mm; }
  * { box-sizing: border-box; }
  body { font-family: "Inter", "Segoe UI", Arial, sans-serif; color: #16181d; font-size: 10.5pt; line-height: 1.5; margin: 0; }
  h1, h2, h3 { font-family: Georgia, "Times New Roman", serif; font-weight: 600; margin: 0 0 4mm; color: #10121a; }
  h1 { font-size: 20pt; }
  h2 { font-size: 13pt; margin-top: 9mm; border-bottom: 1px solid #d8dbe2; padding-bottom: 2mm; }
  p { margin: 0 0 3mm; }
  .muted { color: #6b7078; }
  .mono { font-family: "Consolas", "SF Mono", monospace; font-size: 8.5pt; word-break: break-all; }
  .num { font-variant-numeric: tabular-nums; }
  table { width: 100%; border-collapse: collapse; margin: 3mm 0 5mm; font-size: 9.5pt; }
  th, td { text-align: left; padding: 2mm 3mm; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
  thead th { background: #f4f5f7; font-weight: 600; border-bottom: 1px solid #c7cad1; }
  table.kv th { width: 38mm; color: #6b7078; font-weight: 500; border: none; }
  table.kv td { border: none; }
  .cover { display: flex; align-items: center; gap: 5mm; padding-bottom: 6mm; border-bottom: 2px solid #10121a; margin-bottom: 8mm; }
  .cover img { width: 16mm; height: 16mm; border-radius: 3mm; object-fit: cover; }
  .cover .meta { margin-left: auto; text-align: right; font-size: 9pt; color: #6b7078; }
  .eyebrow { text-transform: uppercase; letter-spacing: 0.08em; font-size: 8.5pt; color: #6b7078; margin-bottom: 1mm; }
  .sheet-section { break-inside: avoid; }
  ul { margin: 0 0 4mm; padding-left: 5mm; }
  li { margin-bottom: 1.5mm; }
  .signoff { display: flex; gap: 12mm; margin-top: 10mm; }
  .signoff > div { flex: 1; }
  .signoff .line { display: block; border-bottom: 1px solid #16181d; height: 12mm; }
  .signoff p { margin-top: 1mm; color: #6b7078; font-size: 8.5pt; }
  footer.hashline { margin-top: 10mm; padding-top: 3mm; border-top: 1px solid #d8dbe2; font-size: 8pt; color: #6b7078; }
  footer.hashline .mono { font-size: 8pt; }
</style>
</head>
<body>
  <div class="cover">
    <img src="/pramaan_logo.jpeg" alt="Pramaan" />
    <div>
      <div class="eyebrow">Pramaan — Forensic Examination Report</div>
      <h1>${esc(c.title || c.id)}</h1>
    </div>
    <div class="meta">
      <div>Case ${esc(c.id)}</div>
      <div>Generated ${genDate} by ${esc(data.generatedBy)}</div>
    </div>
  </div>

  <section class="sheet-section">
    <h2>Case and examiner</h2>
    <table class="kv">
      <tr><th>Case</th><td>${esc(c.id)}</td></tr>
      <tr><th>Station</th><td>${esc(c.station || "Not set")}</td></tr>
      <tr><th>Examiner</th><td>${esc(c.examiner || "—")}</td></tr>
      <tr><th>Opened</th><td>${format(new Date(c.opened), "d MMMM yyyy")}</td></tr>
    </table>
  </section>

  <section class="sheet-section">
    <h2>Device identification</h2>
    <p>The brand is named only from evidence found on the image. A brand name or format signature identifies a storage family, not a model.</p>
    <table>
      <thead><tr><th>Evidence</th><th>Brand</th><th>Format</th><th>Evidence for it</th></tr></thead>
      <tbody>${deviceRows}</tbody>
    </table>
  </section>

  <section class="sheet-section">
    <h2>Acquisition and hashes</h2>
    <p>Each image is hashed once on intake. Every clip and finding derived from it traces back to this value.</p>
    <table>
      <thead><tr><th>ID</th><th>File</th><th class="num">Size</th><th>SHA-256</th><th class="num">Added</th><th>Integrity</th><th>Handling stated at intake</th></tr></thead>
      <tbody>${evidenceRows}</tbody>
    </table>
  </section>

  ${methodRows ? `<section class="sheet-section">
    <h2>Methods and versions</h2>
    <table>
      <thead><tr><th>Evidence</th><th>Steps completed</th><th>Engine and knowledge base</th></tr></thead>
      <tbody>${methodRows}</tbody>
    </table>
  </section>` : ""}

  <section class="sheet-section">
    <h2>Recovered footage</h2>
    <p>Times are the recorder's own clock, moved to UTC with the time zone and drift set for each evidence item. Each recovered clip is decode-checked; a clip that fails is excluded from analysis but listed here.</p>
    <table>
      <thead><tr><th>Evidence</th><th>Camera</th><th>State</th><th class="num">Time (UTC)</th><th>Quality gate</th><th>SHA-256</th></tr></thead>
      <tbody>${recordingRows}</tbody>
    </table>
  </section>

  <section class="sheet-section">
    <h2>Deletion findings</h2>
    <table class="kv">
      <tr><th>Footage found</th><td>${d.counts.deleted} deleted, ${d.counts.live} live, ${d.counts.unknown} not classed</td></tr>
      <tr><th>Deleted footage covers</th><td>${d.deletedPeriod ? esc(d.deletedPeriod) : "no timed deleted footage"}</td></tr>
      <tr><th>Cause</th><td>Not determined. This report lists what the disk holds; it does not decide whether footage was formatted, expired or overwritten.</td></tr>
    </table>
    <p><strong>What the disk shows:</strong></p>
    <ul>${observations}</ul>
    <p><strong>Gaps against the recorder's logs:</strong> a log entry inside a gap is a lead to read, not an explanation.</p>
    <table>
      <thead><tr><th>Camera</th><th class="num">Gap (UTC)</th><th>Log entries inside</th></tr></thead>
      <tbody>${gapRows}</tbody>
    </table>
  </section>

  <section class="sheet-section">
    <h2>Analytics leads</h2>
    <table>
      <thead><tr><th>Finding</th><th>Tool</th><th>Camera</th><th class="num">Time</th><th class="num">Confidence</th><th>Clip</th></tr></thead>
      <tbody>${analysisRows}</tbody>
    </table>
    <p><strong>Coverage</strong> (recordings that passed the quality gate and were analysed)</p>
    <table>
      <thead><tr><th>Camera</th><th class="num">Analysed</th></tr></thead>
      <tbody>${coverageRows}</tbody>
    </table>
    <p><strong>Cross-camera sightings</strong> of the same kind within two minutes. Each is a lead to check by eye, not a confirmed match.</p>
    <table>
      <thead><tr><th>First seen</th><th>Then seen</th><th>Kind</th><th class="num">Gap</th></tr></thead>
      <tbody>${pairRows}</tbody>
    </table>
  </section>

  <section class="sheet-section">
    <h2>Clock sources</h2>
    <p>Which clocks this case holds evidence from. Comparing them for disagreement is not automated.</p>
    <table>
      <thead><tr><th>Source</th><th>What it is</th><th>What the case holds</th><th class="num">State</th></tr></thead>
      <tbody>${clockRows}</tbody>
    </table>
  </section>

  <section class="sheet-section">
    <h2>Section status</h2>
    <table>
      <thead><tr><th>Section</th><th class="num">Status</th><th>Note</th></tr></thead>
      <tbody>${sectionRows}</tbody>
    </table>
  </section>

  <section class="sheet-section">
    <h2>Limitations</h2>
    <ul>${limitationsList}</ul>
  </section>

  ${certificateBlock}

  <footer class="hashline">
    Report content hash (SHA-256): <span class="mono">${reportHash}</span>. Recompute over the JSON export to verify this document was not altered after generation.
  </footer>
</body>
</html>`
}

/** Opens the report in a new tab and triggers the browser's print dialog (Save as PDF). */
export function openPrintable(html: string) {
  const win = window.open("", "_blank")
  if (!win) throw new Error("Pop-up blocked — allow pop-ups for this site to generate the PDF")
  win.document.open()
  win.document.write(html)
  win.document.close()
  const triggerPrint = () => win.print()
  const img = win.document.querySelector("img")
  if (img && !(img as HTMLImageElement).complete) {
    img.addEventListener("load", triggerPrint, { once: true })
    img.addEventListener("error", triggerPrint, { once: true })
  } else {
    win.setTimeout(triggerPrint, 150)
  }
}

export function downloadJson(data: ReportData, reportHash: string, filename: string) {
  const payload = { ...data, reportHash }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
