// Frontend-only fixtures. Shapes follow plan.md (UFR, M4 recovery status, M6 witnesses).

export type CaseStage =
  | "Intake"
  | "Parsing"
  | "Recovering"
  | "Analysing"
  | "Report ready"
  | "Sealed"

export interface CaseRecord {
  id: string
  title: string
  fir: string
  station: string
  examiner: string
  stage: CaseStage
  evidence: number
  opened: string // ISO date
  updated: string
  fresh?: boolean
}

export const cases: CaseRecord[] = [
  { id: "PRM-2026-0142", title: "Jewellery store burglary, Shivaji Nagar", fir: "FIR 0142/2026", station: "Shivaji Nagar PS, Pune", examiner: "R. Deshmukh", stage: "Analysing", evidence: 2, opened: "2026-09-12", updated: "2026-09-29" },
  { id: "PRM-2026-0139", title: "Vehicle theft, Sector 18 parking", fir: "FIR 0871/2026", station: "Sector 20 PS, Noida", examiner: "A. Verma", stage: "Report ready", evidence: 1, opened: "2026-09-08", updated: "2026-09-27" },
  { id: "PRM-2026-0131", title: "ATM tampering, MG Road branch", fir: "FIR 0455/2026", station: "Cubbon Park PS, Bengaluru", examiner: "S. Iyer", stage: "Recovering", evidence: 3, opened: "2026-08-30", updated: "2026-09-26" },
  { id: "PRM-2026-0127", title: "Warehouse fire, Bhiwandi", fir: "FIR 0219/2026", station: "Bhiwandi PS, Thane", examiner: "R. Deshmukh", stage: "Parsing", evidence: 1, opened: "2026-08-24", updated: "2026-09-22" },
  { id: "PRM-2026-0118", title: "Assault outside restaurant, Koregaon Park", fir: "FIR 0388/2026", station: "Koregaon Park PS, Pune", examiner: "K. Pawar", stage: "Sealed", evidence: 2, opened: "2026-08-11", updated: "2026-09-04" },
  { id: "PRM-2026-0109", title: "Cash-van robbery, NH-48", fir: "FIR 0102/2026", station: "Vapi Rural PS", examiner: "A. Verma", stage: "Intake", evidence: 0, opened: "2026-09-28", updated: "2026-09-28" },
]

export const activeCase = cases[0]

export interface EvidenceItem {
  id: string
  name: string
  kind: string
  size: string
  md5: string
  sha256: string
  acquired: string
  verified: boolean
  vendor: string
  fit: number
}

export const evidence: EvidenceItem[] = [
  { id: "EV-01", name: "DVR_HDD1_ch1-8.E01", kind: "EWF · 4 segments", size: "1.82 TB", md5: "9e107d9d372bb6826bd81d3542a419d6", sha256: "3f79bb7b435b05321651daefd374cdc681dc06faa65e374e38337b04a7c6f2d1", acquired: "2026-09-13 11:42", verified: true, vendor: "Dahua DHFS (CP Plus OEM)", fit: 96 },
  { id: "EV-02", name: "DVR_HDD2_ch9-16.dd", kind: "Raw dd", size: "931.5 GB", md5: "e4d909c290d0fb1ca068ffaddf22cbd0", sha256: "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9", acquired: "2026-09-13 15:07", verified: true, vendor: "Dahua DHFS (CP Plus OEM)", fit: 94 },
]

export interface AuditEvent {
  t: string
  who: string
  action: string
  target: string
  hash: string
}

export const audit: AuditEvent[] = [
  { t: "29 Sep, 13:52", who: "R. Deshmukh", action: "Ran deletion analysis", target: "EV-01", hash: "a41f09" },
  { t: "29 Sep, 11:20", who: "R. Deshmukh", action: "Exported clip manifest", target: "clip_ch3_0412.mp4", hash: "77c2be" },
  { t: "28 Sep, 17:03", who: "System", action: "Quality gate excluded 2 clips", target: "EV-02", hash: "0be6d4" },
  { t: "28 Sep, 16:41", who: "System", action: "Recovery finished", target: "EV-01, EV-02", hash: "c93a10" },
  { t: "13 Sep, 15:31", who: "R. Deshmukh", action: "Hash verified (MD5, SHA-256)", target: "EV-02", hash: "5d80ff" },
]

export type FootageStatus = "live" | "deleted" | "repaired" | "excluded"

export const footage: { status: FootageStatus; label: string; clips: number; hint: string }[] = [
  { status: "live", label: "Live", clips: 24, hint: "Referenced by the recorder's index" },
  { status: "deleted", label: "Deleted", clips: 9, hint: "Recovered from unallocated space" },
  { status: "repaired", label: "Repaired", clips: 3, hint: "Parameter sets synthesised" },
  { status: "excluded", label: "Excluded", clips: 2, hint: "Failed the quality gate" },
]

export interface PipelineStep {
  key: string
  label: string
  module: string
  state: "done" | "active" | "todo" | "attention"
  result: string
}

export const pipeline: PipelineStep[] = [
  { key: "intake", label: "Intake", module: "M0", state: "done", result: "2 images hashed, MD5 and SHA-256" },
  { key: "identify", label: "Identify", module: "M1", state: "done", result: "Dahua DHFS, 96% schema fit" },
  { key: "parse", label: "Parse", module: "M2 · M3", state: "done", result: "412,880 frames across 16 channels" },
  { key: "recover", label: "Recover", module: "M4", state: "done", result: "38 clips, 9 from deleted space" },
  { key: "validate", label: "Validate", module: "M4.5", state: "attention", result: "36 passed, 2 excluded" },
  { key: "timeline", label: "Timeline", module: "M6", state: "active", result: "Clock offset ±1.4 s, 1 anchor" },
  { key: "analyse", label: "Analyse", module: "M7", state: "todo", result: "Not started" },
  { key: "report", label: "Report", module: "M9", state: "todo", result: "Not started" },
]

export interface Attention {
  id: string
  title: string
  detail: string
  action: string
  to: string
}

export const attention: Attention[] = [
  { id: "a1", title: "Two clips were not analysed", detail: "ch3 and ch11 fell below the continuity threshold (0.71 and 0.64). They stay in the report as “recovered, not analysed”.", action: "Review clips", to: "recovery" },
  { id: "a2", title: "No seizure clock anchor entered", detail: "Without a photographed recorder clock, absolute time carries ±1.4 s from a single NTP log entry. Add the anchor to tighten it.", action: "Add anchor", to: "timeline" },
]

export interface Witness {
  id: string
  name: string
  source: string
  independent: boolean
  state: "agrees" | "missing" | "conflict"
  offset: string
}

export const witnesses: Witness[] = [
  { id: "W1", name: "Recorder clock", source: "DHAV packed date, local time", independent: true, state: "agrees", offset: "reference" },
  { id: "W2", name: "On-screen display", source: "Burned-in overlay, OCR at 1 fps", independent: false, state: "agrees", offset: "+0.0 s" },
  { id: "W3", name: "Recorder logs", source: "Time-set and NTP-sync events", independent: false, state: "agrees", offset: "−1.4 s at 09 Sep" },
  { id: "W4", name: "Seizure anchor", source: "Photo of recorder clock beside NTP reference", independent: true, state: "missing", offset: "not entered" },
  { id: "W5", name: "Scene events", source: "Sunrise, streetlight switching", independent: true, state: "agrees", offset: "±90 s" },
]

// Minutes from 14 Sep 00:00 IST. Axis is 0 to 360 (six hours around the format).
export const axisMinutes = 360
export const lanes = [
  { ch: "CH 01", name: "Entrance", segs: [{ s: 0, e: 131, k: "deleted" }, { s: 166, e: 360, k: "live" }] },
  { ch: "CH 03", name: "Counter", segs: [{ s: 0, e: 70, k: "deleted" }, { s: 70, e: 131, k: "excluded" }, { s: 166, e: 360, k: "live" }] },
  { ch: "CH 07", name: "Back door", segs: [{ s: 0, e: 131, k: "deleted" }, { s: 166, e: 360, k: "live" }] },
  { ch: "CH 11", name: "Parking", segs: [{ s: 0, e: 100, k: "deleted" }, { s: 100, e: 131, k: "excluded" }, { s: 166, e: 360, k: "live" }] },
] as const

export const formatWindow = { start: 131, end: 166, label: "Format window", range: "14 Sep, 02:11 to 02:46 IST", sigma: "±1.4 s" }

export interface Clip {
  id: string
  ch: string
  name: string
  status: FootageStatus
  range: string
  duration: string
  continuity: number
  gate: "passed" | "excluded"
  reason?: string
  sha: string
}

export const clips: Clip[] = [
  { id: "C-0412", ch: "CH 03", name: "Counter", status: "deleted", range: "14 Sep 01:12 to 02:09", duration: "56 min", continuity: 0.98, gate: "passed", sha: "8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4" },
  { id: "C-0413", ch: "CH 03", name: "Counter", status: "deleted", range: "14 Sep 02:46 to 03:20", duration: "34 min", continuity: 0.71, gate: "excluded", reason: "Low continuity, 29% of frames dropped", sha: "e7f6c011776e8db7cd330b54174fd76f7d0216b304b3a0a5e2a8f5b5f1d3c9a1" },
  { id: "C-0388", ch: "CH 01", name: "Entrance", status: "live", range: "12 Sep 00:00 to 14 Sep 01:58", duration: "49 h 58 min", continuity: 1, gate: "passed", sha: "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae" },
  { id: "C-0401", ch: "CH 01", name: "Entrance", status: "deleted", range: "14 Sep 02:46 to 04:31", duration: "1 h 45 min", continuity: 0.99, gate: "passed", sha: "fcde2b2edba56bf408601fb721fe9b5c338d10ee429ea04fae5511b68fbf8fb9" },
  { id: "C-0420", ch: "CH 07", name: "Back door", status: "repaired", range: "14 Sep 02:50 to 03:04", duration: "14 min", continuity: 0.93, gate: "passed", sha: "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b" },
  { id: "C-0431", ch: "CH 11", name: "Parking", status: "deleted", range: "14 Sep 01:40 to 02:11", duration: "31 min", continuity: 0.64, gate: "excluded", reason: "Low continuity, 36% of frames dropped", sha: "d4735e3a265e16eee03f59718b9b5d03019c07d8b6c51f90da3a666eec13ab35" },
  { id: "C-0395", ch: "CH 11", name: "Parking", status: "live", range: "12 Sep 00:00 to 16 Sep 00:00", duration: "4 d", continuity: 1, gate: "passed", sha: "4e07408562bedb8b60ce05c1decfe3ad16b72230967de01f640b7e4729b49fce" },
]

export const deletion = {
  type: "Formatted",
  confidence: "High",
  window: "14 Sep, 02:11 to 02:46 IST",
  sigma: "±1.4 s",
  evidence: [
    { obs: "Index header reset and write pointer back at the start of the data area", infer: "Points to formatting, not expiry" },
    { obs: "Recoverable frames sit after the newest post-format data", infer: "Residue from before the reset" },
    { obs: "Free space jumped from 4% to 100% between two consecutive index snapshots", infer: "A single wipe, not gradual overwrite" },
  ],
  contradictions: [
    { sev: "danger" as const, what: "Recording gap on CH 03 with no stop, video-loss or reboot log", where: "14 Sep 02:11 to 02:46", sources: "Video vs logs" },
    { sev: "warning" as const, what: "Logged recording on CH 07 with no footage and no expiry entry", where: "14 Sep 02:20 to 02:41", sources: "Logs vs index" },
    { sev: "neutral" as const, what: "Clock jumped 1.4 s forward with a matching NTP sync entry", where: "09 Sep 06:00", sources: "Video vs logs (agree)" },
  ],
}

export const detections = [
  { id: "D-201", cls: "Person", task: "objects", conf: 0.94, ch: "CH 03", t: "14 Sep 01:23:08", status: "deleted" as FootageStatus },
  { id: "D-202", cls: "Person", task: "objects", conf: 0.91, ch: "CH 07", t: "14 Sep 01:24:41", status: "deleted" as FootageStatus },
  { id: "D-203", cls: "Backpack", task: "objects", conf: 0.78, ch: "CH 03", t: "14 Sep 01:31:55", status: "deleted" as FootageStatus },
  { id: "D-204", cls: "Motion", task: "motion", conf: 0.99, ch: "CH 01", t: "13 Sep 22:14:02", status: "live" as FootageStatus },
  { id: "D-205", cls: "Face lead", task: "faces", conf: 0.82, ch: "CH 01", t: "14 Sep 01:22:40", status: "deleted" as FootageStatus },
  { id: "D-206", cls: "Face lead", task: "faces", conf: 0.67, ch: "CH 07", t: "14 Sep 02:52:10", status: "repaired" as FootageStatus },
  { id: "D-207", cls: "Vehicle", task: "objects", conf: 0.88, ch: "CH 11", t: "13 Sep 23:58:31", status: "live" as FootageStatus },
]

export const coverage = [
  { ch: "CH 01", checked: 100, method: "Triage, then decode" },
  { ch: "CH 03", checked: 62, method: "Sampled at 1 fps; 2 clips excluded" },
  { ch: "CH 07", checked: 100, method: "Triage, then decode" },
  { ch: "CH 11", checked: 71, method: "Sampled at 1 fps; H.265+ variable GOP" },
]

export const auditAll = [
  { seq: 5124, d: "2026-09-29", t: "29 Sep 13:52", who: "R. Deshmukh", action: "Ran deletion analysis", caseId: "PRM-2026-0142", prev: "77c2be1a", hash: "a41f09c2" },
  { seq: 5123, d: "2026-09-29", t: "29 Sep 11:20", who: "R. Deshmukh", action: "Exported clip manifest C-0412", caseId: "PRM-2026-0142", prev: "0be6d4f8", hash: "77c2be1a" },
  { seq: 5122, d: "2026-09-28", t: "28 Sep 17:03", who: "System", action: "Quality gate excluded 2 clips", caseId: "PRM-2026-0142", prev: "9c1d02ab", hash: "0be6d4f8" },
  { seq: 5121, d: "2026-09-27", t: "27 Sep 16:02", who: "A. Verma", action: "Generated report", caseId: "PRM-2026-0139", prev: "c93a10de", hash: "9c1d02ab" },
  { seq: 5120, d: "2026-09-26", t: "26 Sep 10:48", who: "S. Iyer", action: "Added image EV-03", caseId: "PRM-2026-0131", prev: "5d80ff37", hash: "c93a10de" },
  { seq: 5119, d: "2026-09-13", t: "13 Sep 15:31", who: "R. Deshmukh", action: "Hash verified (MD5, SHA-256)", caseId: "PRM-2026-0142", prev: "31e4a7b0", hash: "5d80ff37" },
]

// ---------------------------------------------------------------- tool fixtures
export const outputDir = "D:\\SIH-2026-PS150\\backend\\test-assets\\output"
export const testImage = "dvr_test_img.E01"

export interface Recording { id: number; ch: number; start: string | null; end: string | null; offset: string }
const base: [number, string | null, string | null, string][] = [
  [1, "2022-07-06 09:21:06", "2022-07-06 15:48:44", "0x7684c5e000"],
  [1, "2022-07-06 15:48:44", "2022-07-06 20:55:10", "0x74c4c5e000"],
  [1, "2022-07-06 20:55:10", "2022-07-07 03:37:25", "0x78c4c5e000"],
  [1, "2022-07-07 03:37:25", "2022-07-07 12:08:00", "0x7944c5e000"],
  [1, null, null, "0xa7c4c5e000"],
  [1, "2022-07-06 09:51:35", "2022-07-06 17:33:25", "0x75c4c5e000"],
  [1, "2022-07-06 17:33:25", "2022-07-07 00:35:24", "0x76c4c5e000"],
]
const extra: [number, string | null, string | null, string][] = Array.from({ length: 13 }, (_, i) => {
  const h = 6 + i
  return [2 + (i % 3), `2022-07-06 ${String(h).padStart(2, "0")}:10:00`, `2022-07-06 ${String(h + 5).padStart(2, "0")}:40:12`, `0x${(0x7a00 + i * 0x40).toString(16)}c4c5e000`]
})
export const recordings: Recording[] = [...base, ...extra].map(([ch, start, end, offset], id) => ({ id, ch, start, end, offset }))

export const parseLog = [
  "Loading image files for case...",
  "Processing finished. Refreshing image data from database...",
  `Global output directory set to: ${outputDir}`,
  `Adding image D:\\dvr\\dvr_test_img-1\\${testImage} to case...`,
  "[PYTHON LOG] INFO: Master sector found at 0x200, HIKVISION@HANGZHOU signature valid",
  "[PYTHON LOG] INFO: --- Parsing HIKBTREE ---",
  "[PYTHON LOG] INFO: Page list read: 852 video index entries",
  "[PYTHON LOG] INFO: --- Parsing Log Entries ---",
  "[PYTHON LOG] INFO: Found and parsed 12245 system log entries.",
  `[PYTHON LOG] INFO: --- Saving results to ${outputDir}\\system_logs.json ---`,
  "[LOGS] ✓ System logs parsed successfully.",
  "✅ All parsing tasks complete. Saving data to database...",
  "[PYTHON LOG] INFO: Image file handle closed.",
  "✅ All forensic data saved to the database!",
  "Processing finished. Refreshing image data from database...",
  "[PROCESS] Process exited with code 0",
]

export const extractLog = [
  "[PYTHON LOG] INFO: Carving 1018.99 MB of raw video data...",
  "[PYTHON LOG] [DVR-Scan] Cleaning stream: isolating all standard H.264 NAL units...",
  "[PYTHON LOG] [DVR-Scan] Found and stitched together 449328 NAL units.",
  `[PYTHON LOG] [DVR-Scan] Saving cleaned video stream to '${outputDir}\\video_block_at_7684c5e000.h264'...`,
  "[PYTHON LOG] [DVR-Scan] SUCCESS! File saved. Try opening it with a media player like VLC.",
  "[PYTHON LOG] INFO: Image file handle closed.",
  "[PROCESS] Process exited with code 0",
  "Process finished successfully.",
]

export const viewerData = {
  master: {
    image_info: { filename: testImage, full_path: "D:\\dvr\\dvr_test_img-1\\dvr_test_img.E01", size_bytes: 1000204886016 },
    master_sector: {
      extra_offset: 16,
      signature_address: 528,
      disk_capacity: { value: 1000204886016, value_hex: "0xe8e0db6000", address: 584, address_hex: "0x248", raw_bytes: "00 60 DB E0 E8 00 00 00" },
      system_logs_offset: { value: 64041472, value_hex: "0x3d13200", address: 608, address_hex: "0x260", raw_bytes: "00 32 D1 03 00 00 00 00" },
    },
  },
  hikbtree: {
    header: {
      created_time: { value: 1646919414, value_readable: "2022-03-10 19:06:54 UTC", address: 1000204459068, address_hex: "0xe8e0d4dc3c" },
      footer_address: { value: 1000204540928, value_readable: "0xe8e0d61c00", address: 1000204459072, address_hex: "0xe8e0d4dc40" },
      page_list_address: { value: 1000204463104, value_readable: "0xe8e0d4ec00", address: 1000204459088, address_hex: "0xe8e0d4dc50" },
      page_1_address: { value: 1000204467200, value_readable: "0xe8e0d4fc00", address: 1000204459096 },
    },
  },
  logs: {
    log_header_info: { start_address: 64041488, start_address_hex: "0x3d13210", size_bytes: 2032, raw_hex_preview: "B7 00 00 00 E6 00 00 00 39 29 00 00 DE" },
    system_logs: [
      {
        entry_number: 1, address: 64043520, address_hex: "0x3d13a00", timestamp_unix: 1655367390,
        timestamp_readable: "2022-06-16 13:46:30 UTC", log_type_code: 4, log_type_name: "Information - System status reports",
        description: { parsed_type: "Periodic System Statistics", details: { counter_value_1: 21626880, counter_value_2: 0 } },
      },
    ],
  },
}
