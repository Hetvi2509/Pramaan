// Fixtures for OEM comparison, device identification, acquisition and correlation.
// Layout facts follow plan.md; anything not yet checked on a real disk says so.

export type Validation = "validated" | "documented" | "assumed" | "unknown"
export type Adapter = "Built" | "Planned" | "Induction only"

export interface Oem {
  name: string
  layout: string
  index: string
  time: string
  validation: Validation
  adapter: Adapter
  basis: string
}

export const oems: Oem[] = [
  { name: "Hikvision", layout: "MPEG-PS blocks (IMKH header)", index: "HIKBTREE1 / HIKBTREE2, master sector, RATS logs", time: "Pseudo-epoch; local or UTC to be verified per disk", validation: "validated", adapter: "Built", basis: "Parsed on dvr_test_img.E01 (852 recordings, 12,245 log entries)" },
  { name: "Dahua", layout: "DHAV records, footer “dhav”", index: "DHFS, logs (Dragonas 2024)", time: "Packed date bitfield, recorder local time", validation: "documented", adapter: "Planned", basis: "Record layout from FFmpeg dhav.c; no disk imaged yet" },
  { name: "CP Plus", layout: "Expected DHAV (Dahua OEM)", index: "Expected DHFS", time: "Expected packed local time", validation: "assumed", adapter: "Planned", basis: "Lineage assumed, not measured. Needs a real disk." },
  { name: "Honeywell", layout: "20-byte custom header, u64 µs Unix time", index: "GPT, block-group index, channel list, record state", time: "Microseconds since Unix epoch", validation: "documented", adapter: "Planned", basis: "Published layout (Yoon & Hwang 2026); synthetic image only" },
  { name: "TP-Link", layout: "Unknown", index: "Unknown", time: "Unknown", validation: "unknown", adapter: "Induction only", basis: "No disk or documentation yet. Blind schema induction if a disk turns up." },
  { name: "Godrej", layout: "Unknown", index: "Unknown", time: "Unknown", validation: "unknown", adapter: "Induction only", basis: "No disk or documentation yet" },
  { name: "Uniview", layout: "Unknown", index: "Unknown", time: "Unknown", validation: "unknown", adapter: "Induction only", basis: "No disk or documentation yet" },
  { name: "Matrix", layout: "Unknown", index: "Unknown", time: "Unknown", validation: "unknown", adapter: "Induction only", basis: "No disk or documentation yet" },
]

export const drives = [
  { id: "d1", name: "Seagate SkyHawk ST2000VX008", size: "1.82 TB", serial: "ZDZ3K1QP", protected: true },
  { id: "d2", name: "WD Purple WD10PURZ", size: "931.5 GB", serial: "WCC7K4XY", protected: false },
]

export const identification = {
  family: "Dahua DHFS",
  oem: "CP Plus (rebranded, to verify)",
  model: "16-channel hybrid DVR",
  firmware: "V4.001.0000000.2",
  serial: "6K0A1B2PAZ3F4C5",
  confidence: 96,
  fit: [
    { name: "Dahua DHFS", score: 96 },
    { name: "Generic MPEG-PS", score: 11 },
    { name: "Hikvision HIKBTREE", score: 4 },
    { name: "Honeywell GPT layout", score: 2 },
  ],
  evidence: [
    { what: "DHFS superblock magic", where: "Offset 0x0", weight: "Strong", detail: "Names the file system family" },
    { what: "DHAV record magic", where: "412,880 records", weight: "Strong", detail: "Validated frames explained by the Dahua schema: 96%" },
    { what: "Model string", where: "Machine data, sector 34", weight: "Medium", detail: "Read as text; not used to pick the parser" },
    { what: "Firmware string", where: "System log entry 1", weight: "Medium", detail: "Read from the first log record" },
    { what: "Hikvision and Honeywell signatures", where: "Whole image", weight: "None", detail: "HIKBTREE, RATS and GPT partition signatures not found" },
  ],
}

export const pairs = [
  { t: "14 Sep 01:23:08", a: "CH 03", b: "CH 07", cls: "Person", gap: 4, sub: "01:23:08 and 01:23:12" },
  { t: "14 Sep 01:24:41", a: "CH 01", b: "CH 03", cls: "Person", gap: 9, sub: "01:24:32 and 01:24:41" },
  { t: "14 Sep 01:31:55", a: "CH 03", b: "CH 11", cls: "Backpack", gap: 22, sub: "01:31:55 and 01:32:17" },
  { t: "13 Sep 23:58:31", a: "CH 11", b: "CH 01", cls: "Vehicle", gap: 27, sub: "23:58:31 and 23:58:58" },
]
