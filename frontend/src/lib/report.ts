// Builds the actual report document (HTML for print-to-PDF, plus JSON) from real case/evidence
// data and the analysis fixtures the rest of the app already shows (see lib/mock.ts). No PDF
// library: the browser's own print-to-PDF (window.print) produces the file, so layout is plain
// CSS and stays fully under our control.
import { format } from "date-fns"
import type { ApiCase, ApiImageFile } from "@/lib/api"
import {
  coverage,
  deletion,
  detections,
  witnesses,
  type CaseRecord,
} from "@/lib/mock"
import { identification, oems, pairs } from "@/lib/mock-forensics"

export interface ReportSection {
  name: string
  ready: boolean
  note?: string
}

export interface EvidenceProcessing {
  image: ApiImageFile
  steps: string[]
}

export interface ReportData {
  generatedAt: Date
  generatedBy: string
  caseInfo: { id: string; title: string; fir: string; station: string; examiner: string; opened: string }
  images: ApiImageFile[]
  processing: EvidenceProcessing[]
  sections: ReportSection[]
  certificate: { part: "a" | "b"; expertName: string }
}

const STEP_LABEL: Record<string, string> = {
  intake_hashes: "Hashed at intake (MD5, SHA-256)",
  media_hashes: "Media re-hashed",
  identification: "Recorder format identified",
  parsed_bundle: "Index parsed",
  integrity: "Hash re-verified against intake",
}

function stepLabel(dataType: string): string {
  if (dataType.startsWith("extraction_")) return `Recording extracted (${dataType.slice("extraction_".length)})`
  return STEP_LABEL[dataType] ?? dataType
}

export function computeSections(images: ApiImageFile[]): ReportSection[] {
  const unchecked = coverage.filter((c) => c.checked < 100)
  const missingWitness = witnesses.find((w) => w.state === "missing")
  return [
    { name: "Case and examiner", ready: true },
    { name: "Device identification", ready: true },
    { name: "Acquisition and hashes", ready: images.length > 0 && images.every((i) => !!i.hash_sha256), note: images.length === 0 ? "No evidence added to this case yet" : undefined },
    { name: "Methods and parser versions", ready: true },
    { name: "Recovered footage", ready: true },
    { name: "Deletion findings", ready: true },
    { name: "Timeline with uncertainty", ready: !missingWitness, note: missingWitness ? `${missingWitness.id} (${missingWitness.name}) not entered` : undefined },
    { name: "Analytics leads and unchecked windows", ready: unchecked.length === 0, note: unchecked.length ? `Analysis has not fully run on ${unchecked.map((c) => c.ch).join(", ")}` : undefined },
    { name: "Limitations", ready: true },
  ]
}

export async function buildReportData(
  caseId: string,
  caseInfo: { real: ApiCase | null; mock: CaseRecord },
  images: ApiImageFile[],
  getForensics: (imageId: number) => Promise<Record<string, unknown>>,
  certificate: { part: "a" | "b"; expertName: string },
  generatedBy: string
): Promise<ReportData> {
  const c = caseInfo.real
    ? { id: String(caseInfo.real.id), title: caseInfo.real.name, fir: "", station: caseInfo.real.description ?? "Not set", examiner: caseInfo.mock.examiner, opened: caseInfo.real.created_at }
    : { id: caseInfo.mock.id, title: caseInfo.mock.title, fir: caseInfo.mock.fir, station: caseInfo.mock.station, examiner: caseInfo.mock.examiner, opened: caseInfo.mock.opened }

  const processing: EvidenceProcessing[] = []
  for (const image of images) {
    const data = await getForensics(image.id).catch(() => ({}) as Record<string, unknown>)
    processing.push({ image, steps: Object.keys(data).map(stepLabel) })
  }

  return {
    generatedAt: new Date(),
    generatedBy,
    caseInfo: c,
    images,
    processing,
    sections: computeSections(images),
    certificate,
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

const sevLabel = { danger: "Conflict", warning: "Check", neutral: "Consistent" } as const

export function renderReportHtml(data: ReportData, formats: string[], reportHash: string): string {
  const { caseInfo: c, images, processing, sections, certificate } = data
  const includeS63 = formats.includes("s63")
  const genDate = format(data.generatedAt, "d MMMM yyyy, HH:mm")
  const openSections = sections.filter((s) => !s.ready)
  const dvrFit = oems.find((o) => o.name.toLowerCase().includes(identification.oem.toLowerCase().split(" ")[0])) ?? oems[1]

  const evidenceRows = images.length
    ? images.map((i) => `
      <tr>
        <td>EV-${i.id}</td>
        <td>${esc(i.filename)}</td>
        <td class="num">${fmtSize(i.size_bytes)}</td>
        <td class="mono">${i.hash_sha256 ?? "pending"}</td>
        <td class="num">${format(new Date(i.created_at), "d MMM yyyy, HH:mm")}</td>
      </tr>`).join("")
    : `<tr><td colspan="5" class="muted">No evidence has been added to this case yet.</td></tr>`

  const processingRows = processing.length
    ? processing.map((p) => `
      <tr>
        <td>EV-${p.image.id} · ${esc(p.image.filename)}</td>
        <td>${p.steps.length ? p.steps.map(esc).join("<br/>") : '<span class="muted">No analysis run yet</span>'}</td>
      </tr>`).join("")
    : ""

  const fitRows = identification.fit.map((f) => `<tr><td>${esc(f.name)}</td><td class="num">${f.score}%</td></tr>`).join("")

  const evidenceForFindings = [
    ...deletion.evidence.map((e) => `<li><strong>${esc(e.obs)}</strong> — ${esc(e.infer)}</li>`),
  ].join("")

  const contradictionRows = deletion.contradictions.map((row) => `
    <tr>
      <td>${esc(row.what)}</td>
      <td class="num">${esc(row.where)}</td>
      <td>${esc(row.sources)}</td>
      <td class="num">${sevLabel[row.sev]}</td>
    </tr>`).join("")

  const detectionRows = detections.map((d) => `
    <tr>
      <td>${esc(d.cls)}</td>
      <td>${esc(d.ch)}</td>
      <td class="num">${esc(d.t)}</td>
      <td class="num">${(d.conf * 100).toFixed(0)}%</td>
      <td class="num">${esc(d.status)}</td>
    </tr>`).join("")

  const coverageRows = coverage.map((c2) => `
    <tr>
      <td>${esc(c2.ch)}</td>
      <td class="num">${c2.checked}%</td>
      <td>${esc(c2.method)}</td>
    </tr>`).join("")

  const pairRows = pairs.map((p) => `
    <tr>
      <td class="num">${esc(p.t)}</td>
      <td>${esc(p.a)} &harr; ${esc(p.b)}</td>
      <td>${esc(p.cls)}</td>
      <td class="num">${p.gap}s</td>
    </tr>`).join("")

  const witnessRows = witnesses.map((w) => `
    <tr>
      <td>${esc(w.id)} — ${esc(w.name)}</td>
      <td>${esc(w.source)}</td>
      <td class="num">${esc(w.offset)}</td>
      <td class="num">${esc(w.state)}</td>
    </tr>`).join("")

  const sectionRows = sections.map((s) => `
    <tr>
      <td>${esc(s.name)}</td>
      <td class="num">${s.ready ? "Ready" : "Open"}</td>
      <td>${s.note ? esc(s.note) : ""}</td>
    </tr>`).join("")

  const limitationsList = [
    "Solid-state recorders can erase deleted data on their own (TRIM, wear levelling); this finding applies to spinning-disk media where residue is recoverable.",
    "Absolute timestamps carry the uncertainty of the witness sources listed above; no seizure-time clock photograph has been entered for this case.",
    ...openSections.map((s) => `${s.name}: ${s.note ?? "not yet complete"}.`),
  ].map((t) => `<li>${esc(t)}</li>`).join("")

  const certificateBlock = includeS63 ? `
    <section class="sheet-section">
      <h2>Certificate under BSA 2023, Section 63(4)</h2>
      <p>${certificate.part === "a" ? "Part A — certified by the party producing the evidence." : "Part B — certified by the forensic expert who conducted the examination."}</p>
      <table class="kv">
        <tr><th>Certifying expert</th><td>${esc(certificate.expertName)}</td></tr>
        <tr><th>Case reference</th><td>${esc(c.id)}</td></tr>
        <tr><th>Statement</th><td>To the best of my knowledge and belief, the electronic record described in this report was produced by the device identified above, and this document accurately and completely describes the manner of its production and the hash values by which its integrity may be verified.</td></tr>
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
  .mono { font-family: "Consolas", "SF Mono", monospace; font-size: 9pt; word-break: break-all; }
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
      <div>Case ${esc(c.id)}${c.fir ? ` · ${esc(c.fir)}` : ""}</div>
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
    <table class="kv">
      <tr><th>Family</th><td>${esc(identification.family)}</td></tr>
      <tr><th>OEM</th><td>${esc(identification.oem)}</td></tr>
      <tr><th>Model</th><td>${esc(identification.model)}</td></tr>
      <tr><th>Firmware</th><td>${esc(identification.firmware)}</td></tr>
      <tr><th>Confidence</th><td>${identification.confidence}%</td></tr>
      <tr><th>Layout reference</th><td>${esc(dvrFit.layout)} — ${esc(dvrFit.basis)}</td></tr>
    </table>
    <table>
      <thead><tr><th>Candidate schema</th><th class="num">Fit score</th></tr></thead>
      <tbody>${fitRows}</tbody>
    </table>
  </section>

  <section class="sheet-section">
    <h2>Acquisition and hashes</h2>
    <p>Each image is hashed once on intake. Every clip, frame and finding derived from it traces back to this value.</p>
    <table>
      <thead><tr><th>ID</th><th>File</th><th class="num">Size</th><th>SHA-256</th><th class="num">Acquired</th></tr></thead>
      <tbody>${evidenceRows}</tbody>
    </table>
  </section>

  ${processing.length ? `<section class="sheet-section">
    <h2>Methods run per image</h2>
    <table>
      <thead><tr><th>Evidence</th><th>Steps completed</th></tr></thead>
      <tbody>${processingRows}</tbody>
    </table>
  </section>` : ""}

  <section class="sheet-section">
    <h2>Deletion findings</h2>
    <table class="kv">
      <tr><th>Type</th><td>${esc(deletion.type)}</td></tr>
      <tr><th>Format window</th><td>${esc(deletion.window)} (uncertainty ${esc(deletion.sigma)})</td></tr>
      <tr><th>Confidence</th><td>${esc(deletion.confidence)}</td></tr>
    </table>
    <p><strong>What supports this:</strong></p>
    <ul>${evidenceForFindings}</ul>
    <table>
      <thead><tr><th>Observation</th><th class="num">When</th><th>Sources</th><th class="num">Result</th></tr></thead>
      <tbody>${contradictionRows}</tbody>
    </table>
  </section>

  <section class="sheet-section">
    <h2>Recovered footage and analytics leads</h2>
    <table>
      <thead><tr><th>Class</th><th>Channel</th><th class="num">Time</th><th class="num">Confidence</th><th class="num">Status</th></tr></thead>
      <tbody>${detectionRows}</tbody>
    </table>
    <p><strong>Channel coverage</strong></p>
    <table>
      <thead><tr><th>Channel</th><th class="num">Checked</th><th>Method</th></tr></thead>
      <tbody>${coverageRows}</tbody>
    </table>
    <p><strong>Cross-channel correlation</strong></p>
    <table>
      <thead><tr><th class="num">Time</th><th>Channels</th><th>Class</th><th class="num">Gap</th></tr></thead>
      <tbody>${pairRows}</tbody>
    </table>
  </section>

  <section class="sheet-section">
    <h2>Timeline witnesses</h2>
    <table>
      <thead><tr><th>Witness</th><th>Source</th><th class="num">Offset</th><th class="num">State</th></tr></thead>
      <tbody>${witnessRows}</tbody>
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
