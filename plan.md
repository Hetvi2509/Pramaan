# Niriksha 2.0 — Technical Implementation Plan

**SIH 2026 · PS 26150 · Vendor-agnostic DVR/NVR forensic analysis platform**
Status: plan v3 (2026-09-29, M7 tiering corrected + D-FINE eval added after full PS coverage review) · Baseline: `Niriksha-main` (Hikvision-only prototype)

> **Timeline reality:** idea submission deadline 30 Sep 2026; Grand Finale (36 h, offline) December 2026
> ⇒ ~10 weeks of build time. Scope is tiered (§5): **Must** → **Differentiators 1–3** → **Nice** → **Roadmap**.
> Competing teams already show NAL carving, channel de-interleaving, hash-chained audit logs, §63 PDFs,
> YOLO and 8-vendor claims — those are the *baseline*, not our differentiators.

---

## 0. Thesis

Every DVR/NVR vendor hides video inside a different proprietary layout, but the payload is always
standard H.264/H.265 — often inside a thin wrapper or even a standard container (MPEG-PS, TS, RTP, FLV,
fMP4). We (1) recognise standard containers first, (2) use the codec's strict syntax as a
**vendor-independent anchor** and infer only the remaining proprietary fields, (3) normalise everything
into one **Unified Frame Record (UFR)**, and build recovery, deletion analysis, time normalisation,
analytics and reporting on that single representation. Learned or heuristic components only
*propose*; a deterministic verifier *decides*, so every reported artefact can be re-derived without any
model (BSA 2023 §63).

---

## 1. Novelty map

Legend — **N** = novel to our knowledge (~50 works surveyed, 2024–2026) · **A** = known technique, new
application to DVR forensics · **E** = engineering · **H** = hypothesis, claim only after verification on real disks.

| Module | Contribution | Class | Tier |
|---|---|---|---|
| M3 Frame discovery | Binary field inference (as in BinaryInferno NDSS'23, BinPRE CCS'24, FLINT JNCA) **applied to storage forensics and anchored on the video codec** — new SPS-resolution-equality and NAL-type-flag tests | **N (scoped)** | Differentiator 1 |
| M5 Deletion analysis | Deletion-type classifier + **bounded format-time window**; log↔video contradiction detection (fills future work of Yoon & Hwang 2026) | **N** | Differentiator 2 |
| M6 Timeline | Timestamps as **UTC ± σ** with witness provenance; tamper flags **only between independent clocks** | **N** | Differentiator 3 |
| M7 Analytics | Frame-size triage gating AI, with **measured** speed-up and miss rate; unchecked windows reported; runs on recovered (deleted/repaired) footage, not only live | A | **Must (basic detection)** → Nice (triage, refinements) |
| M1 Identification | Vendor/OEM family by schema-fit likelihood rather than one magic string | A/N | Must (basic) |
| M4 Recovery | Run-level channel attribution with temporal cannot/must-link constraints + scene matching (colour-mode aware) | N | Must (basic) → Nice |
| M4.5 Recovery validation | Decode-check + quality gate between recovery and analytics: stops face/object detection from running on unplayable or garbled recovered clips and producing false leads | E | Must |
| M2 FS parsing | HIKBTREE1 vs HIKBTREE2 differential as deletion evidence | **H** | verify on 2–3 disks first |
| M0 / M8 Integrity | MD5 + SHA-256, hash-chained audit log (no blockchain), per-clip manifest | A/E | Must |
| M9 Reporting | BSA §63(4) certificate (Schedule Part A party / Part B expert, hash values) | E | Must |
| M10 CABM | Byte-level model, parsers-as-teachers, domain-randomised wrappers, symbolic verifier | N (research) | Roadmap |

**Tiering correction:** the problem statement names "Machine Learning" as one of only seven key modules
(alongside Device Identification, Acquisition, File System & Format Parsing, Recovery, Timeline Analysis,
Reporting) and explicitly requires "AI-based analytics such as face, object, and motion detection." M7's
**basic detection** (motion, objects, face leads — see §M7) is therefore **Must**, not optional; it is
also the cheapest Must item on the list, since Niriksha already has all three models wired in and only
needs bugs B8/B9 fixed. Only the *refinements around it* — triage gating for speed, day/night
normalisation, model benchmarking — stay Nice.

Positioning sentence for judges: *"Field inference for binary formats exists for network protocols; we
are, to our knowledge, the first to apply it to DVR/NVR storage using the video codec itself as the
anchor, and to report every recovered timestamp with an uncertainty bound."*

---

## 2. End-to-end pipeline

```
 INPUT                                                                        OUTPUT
 .E01/.dd/.img/.raw ─┐
 physical disk (WB) ─┴► M0 Intake ─► M1 Identify ─► M2 FS/Index parse ─┐
                        MD5+SHA256,    vendor,        allocated frames │
                        audit chain    model, disk    + logs           ▼
                                        M3.0 standard-container pass (PS/TS/RTP/FLV/fMP4)
                                        M3.1 codec-anchored frame discovery
                                        M3.2 schema induction (residual bytes only) ──► UFR store
                                                                                  │
                  ┌───────────────────────────────┬───────────────────────────────┤
                  ▼                               ▼                               ▼
          M4 Recovery & reconstruction    M5 Deletion/anti-forensics      M6 Time normalisation
          per-channel MP4 (real PTS),     type + format-time window,      UTC ± σ, witness
          live vs deleted                 log↔video contradictions        provenance, tamper flags
                  ▼
          M4.5 Recovery validation — decode-check + quality gate
          pass → tagged clip (live/deleted/repaired) reaches M7
          fail → excluded from analytics, reason logged, still reaches M9
                  └───────────────┬───────────────┴───────────────┬───────────────┘
                                  ▼                               ▼
              M7 Analytics (triage-gated, on ALL passing clips)  M8 Clip manifests
                                  └───────────────┬───────────────┘
                                                  ▼
                                   M9 Report: PDF + JSON + BSA §63 draft
```

**Runtime architecture (kept from Niriksha):** Electron main (TypeScript, Prisma/SQLite: cases, evidence,
audit) ↔ Python engine (PyInstaller exe) over stdio JSON. Per-frame data bypasses Prisma: one
`frames.sqlite` per evidence image (batch inserts). Fully offline / air-gapped.

### 2.1 Unified Frame Record (UFR)

| Field | Type | Notes |
|---|---|---|
| `image_id` | int | evidence item |
| `offset`, `length` | int64 | payload byte range(s); a frame may span several PES/record pieces → list of ranges |
| `wrapper_ranges` | list | vendor/container header byte ranges (provenance) |
| `record_type` | enum | **video / audio / aux / index / unknown** (DHAV and PS carry several) |
| `codec` | enum | h264 / h265 / mjpeg / g711 / aac / unknown |
| `nal_types`, `is_key` | list, bool | from codec parse |
| `sps_fp` | str | hash of SPS+PPS+VUI |
| `width`, `height` | int | from SPS, cross-checked with wrapper |
| `channel`, `stream` | int? | index/wrapper; null → filled by M4 |
| `t_raw`, `t_enc` | int64, enum | raw value + encoding: `unix_utc_s`, `unix_utc_us`, **`local_naive`**, `dahua_packed_local`, `pes_pts_90k`, `bcd_local`, … |
| `t_witness` | enum | which clock produced it: `recorder`, `camera`, `osd_recorder`, `osd_camera`, `index`, `log` |
| `counter` | int? | vendor frame counter |
| `source` | enum | `index` / `container` / `carve` |
| `allocated` | bool? | referenced by a live index entry |
| `run_id` | int | contiguous same-stream run (M4) |
| `schema_id` | str | hash of the parser/schema that decoded it |
| `t_utc`, `t_sigma` | float | filled by M6 |
| `flags` | bitset | out-of-order, clock-jump, checksum-fail, color-mode, … |

### 2.2 Engine CLI

```
engine ingest    --image X --case C          # M0
engine identify  --image X                   # M1
engine parse     --image X                   # M2
engine scan      --image X [--induce]        # M3 → frames.sqlite
engine recover   --image X [--channel N]     # M4
engine deletion  --image X                   # M5
engine timeline  --case C [--anchors a.json] # M6
engine analyze   --case C --task triage|motion|objects|faces
engine report    --case C --format pdf,json  # M8 + M9
engine verify    --manifest clip.json
```

---

## 3. Module specifications

### Phase 0 — Fix the baseline first (Must, week 1)

| # | Location | Defect | Fix |
|---|---|---|---|
| B1 | `hikvision/idr_parser.py:96,166`, `helpers.py:53`, `system_logs.py:240` | `fromtimestamp()` = machine-local time labelled "UTC" | decode raw value with `timezone.utc`, **and** record `t_enc`: if the vendor stores local wall-clock as pseudo-epoch → `local_naive` + recorder TZ (verify per vendor on real disks, otherwise still 5.5 h off the other way) |
| B2 | `hikvision/hikbtree.py:134` | page list capped at 8192 B (≤169 pages) | read `80 + total_pages*48` |
| B3 | `hikvision/idr_parser.py:129,140` | sorts by time, drops records >15 days from median ⇒ destroys tamper evidence | keep disk order, flag, never drop |
| B4 | `hikvision/extractor.py:72` | ~1 GB block read into RAM | stream in chunks |
| B5 | `hikvision/extractor.py:19` | 4-byte start codes only, H.264 only, channels mixed, PS headers left in stream | replaced by M3.0/M3.1/M4 |
| B6 | `backend/src/ipcHandlers.ts:255` | hashing optional; hashes `.E01` segment 1 only | mandatory M0 hashing of media |
| B7 | `backend/src/ipcHandlers.ts:173` | case delete hard-deletes evidence rows | soft delete + audit event |
| B8 | `criminal_detection/face_utils.py:203,218` | 0.25× downscale; relative time | M7 face path, M6 time |
| B9 | `object_detection/inference.py`, `cli.py:349` | RF-DETR base on every frame, burned-in output only | M7: nano, triage-gated, rows in DB |
| B10 | `paddle-ocr/ocr_service.py:83` | document unwarp/orientation models on CCTV overlays | ROI OCR, doc models off |

---

### M0 — Evidence intake & acquisition (Must)

**Input:** disk behind a hardware write-blocker, or `.E01/.Ex01` (all segments) / `.dd/.img/.raw`.
**Output:** `EvidenceItem`, full-media **MD5 + SHA-256**, audit events.

1. Acquire (physical): `ewfacquire` or `dd` + sidecar; record device model/serial/capacity, examiner, reference time source.
2. One shared `ImageReader` (merge the three duplicate copies in `hikbtree.py`, `system_logs.py`, `helpers.py`).
3. Single-pass MD5 + SHA-256 of the **media** (for E01: also compare with the hash stored in the container).
4. Bad sectors: zero-fill, log ranges, report.
5. Audit chain: `AuditEvent{ts_utc, user, action, target, params, prev_hash, hash=SHA256(prev_hash‖event)}` — tamper-evident without blockchain.
6. **SOP — seizure clock anchor (W4):** photograph the recorder's on-screen clock beside an NTP-synced reference; enter both; note recorder timezone/DST settings from its menu.

Roadmap: Merkle-chunked hashing + RFC 3161 token (enables per-clip inclusion proofs, partial verification of failing disks).

Novel points: **A/E** — hash-chained audit log instead of blockchain (same guarantee for a single lab, no network).

---

### M1 — Device & vendor identification (Must, basic)

**Output:** `{vendor_family, model?, firmware?, serial?, layout, candidate_parsers[], confidence}`.

1. MBR/GPT parse (Honeywell = GPT + proprietary partition + ext4; many DVRs raw).
2. Signatures: `HIKVISION@HANGZHOU`, `HIKBTREE`, `RATS`; `DHFS`/`DHAV`; Honeywell machine-data sector 34; MPEG-PS pack start `00 00 01 BA`, IMKH header.
3. Model/serial/firmware strings from logs, machine-data, ext4 system partition.
4. Schema-fit scoring (after M3): which parser/schema explains the most validated frames ⇒ family; none above threshold ⇒ "unknown → induce".
5. **OEM lineage is measured, not assumed:** CP Plus, Godrej, Matrix, Uniview checked on real disks for DHAV / Hikvision-PS / other.

Novel points: **A/N** — family identification by schema fit, robust to corrupted superblocks and rebranded firmware.

---

### M2 — File system & index parsing (vendor adapters)

Adapters implement `parse(reader) -> (frames, logs, index_snapshots)` and emit UFR.

| Adapter | Source of truth | Tier |
|---|---|---|
| Hikvision | master sector, HIKBTREE1/2, OFNI tables, `RATS` logs; data blocks are **MPEG-PS** (IMKH 40-B header, pack/PES headers; frames split across PES packets) → handled by M3.0 PS demux | Must |
| Dahua / CP Plus | DHFS + **DHAV records** (layout below) + logs (Dragonas 2024) | Must |
| Honeywell | GPT → Partition 1 layout of Yoon & Hwang 2026 (block-group index @0x40, block list @0x40000, channel list @0x400000, record state @0x40000000, video data @0x80000000 with 20-B custom header: type, `80 01 00`, W, H, len, u64 µs unix; 20-B zero end-of-channel delimiter) | only with a real disk; else synthetic image, **labelled synthetic** |
| Generic | none — defers to M3 | Differentiator 1 |

**DHAV record (per FFmpeg `libavformat/dhav.c`):**

| Bytes | Field |
|---|---|
| 0–3 | `DHAV` |
| 4 | type (0xFD video, 0xF0 audio, others aux/key) |
| 5 | subtype |
| 6 | channel |
| 7 | frame sub-number |
| 8–11 | frame number (u32 LE) |
| 12–15 | record length (u32 LE) |
| 16–19 | date, packed bitfield **local time** (sec 0–5, min 6–11, hour 12–16, day 17–21, month 22–25, year 26–31 + 2000) |
| 20–21 | timestamp (u16) |
| 22 | extension length |
| 23 | checksum |
| 24 … 24+ext | **variable** extension: sub-types 0x80/0x82 dimensions, 0x81 codec + fps, 0x83/0x8C audio params, others skipped |
| payload | H.264/H.265 or audio |
| footer | `dhav` + u32 length (8 B) |

Payload offset = `24 + ext_length`, never a fixed 24.

Index snapshots & logs
1. Hikvision: parse both B-tree copies. **Hypothesis H-M2:** HIKBTREE1 and HIKBTREE2 diverge after deletion/overwrite. Test on 2–3 real disks; claim novelty only if they diverge.
2. Always usable regardless of H-M2: "No Video" entries (existence ≠ 0, `hikbtree.py:218`) and blocks whose OFNI times precede the index start ⇒ residue candidates for M4/M5.
3. Logs → structured events `{t_raw, t_enc, type, channel?, user?, raw}` by record structure (replace `b'admin' in raw`), extracting **time-set / NTP-sync / format / HDD-init / record start-stop / video-loss / reboot**.

---

### M3 — Frame discovery & schema induction

**M3.0 Standard-container pass (Must).** Before any induction, explain bytes with standard parsers:
MPEG-PS (pack `00 00 01 BA`, PES `00 00 01 E0–EF/C0–DF/BD`), MPEG-TS (0x47 every 188/192 B), RTP,
FLV, fragmented MP4 (`moof/mdat`). Demux PES by stream id (video / audio separately), reassemble
frames split across PES packets, take PTS/DTS (33-bit, 90 kHz, bit-packed with marker bits) as
`t_raw` with `t_enc = pes_pts_90k`. Only **unexplained** bytes go to M3.2.

**M3.1 Codec prescan (Must).**
1. Stream 64 MiB windows (64 KiB overlap); find `00 00 01` / `00 00 00 01` (**Annex-B**, start-code delimited). Separately, scan for **length-prefixed** NAL units (AVCC/HVCC-style: a 4-byte big-endian length immediately followed by that many bytes of valid NAL data) — some proprietary wrappers use this instead of start codes, the same way MP4 stores H.264 internally. A vendor's records are treated as one or the other consistently, not mixed.
2. Accept NAL only if the syntax chain holds: `forbidden_zero_bit=0`; valid H.264/H.265 type; SPS parses (profile in known set, sane level, 64 ≤ W,H ≤ 8192); PPS → SPS id exists; slice → PPS id exists; `first_mb_in_slice` < picture MBs. Implementation: reuse `libavcodec`'s SPS/PPS/slice-header parsers (via PyAV/FFmpeg bindings) rather than hand-rolling Exp-Golomb decoding — it's already correct and battle-tested.
3. Group into access units; `sps_fp`; IDR/IRAP marks. Entropy prefilter; unallocated-first when an index exists.

**M3.2 Schema induction on residual bytes (Differentiator 1).**
1. Collect residual segments **between pieces of payload** (not assumed to be one per frame): bytes between consecutive validated payload pieces that M3.0 could not explain.
2. Separate **record types first**: cluster by leading bytes + type-like byte values; allow several record types per vendor (video / audio / aux), each with its own schema.
3. Per cluster, align at segment end and start; test hypotheses at every offset × width {1,2,4,8 B} × endianness **and bit-packed fields** (bit offset/width scan; marker-bit patterns; packed date bitfields; 33-bit PTS):

| Field role | Test |
|---|---|
| magic | constant ≥ 99 % |
| length | = payload length or distance to next record ± constant |
| **extension length** | = distance from fixed header end to payload start (discovers variable-length parts, e.g. DHAV ext) |
| timestamp | some encoding (unix s/ms/µs, FILETIME, packed date bitfield, BCD, 90 kHz PTS) gives dates in [2005, acquisition + 1 d]; monotone within partition ≥ 95 %; step ≈ 1/fps |
| resolution *(codec-anchored)* | = SPS width/height (or /8, /16 scaled) |
| frame-type flag *(codec-anchored)* | high mutual information with NAL type |
| record type | low-cardinality byte that separates codec vs audio payloads |
| channel | ≤ 64 values; partitioning makes `sps_fp` homogeneous and times/counters monotone |
| counter | +1 step ≥ 95 % |
| checksum | sum/XOR/CRC8/16/32 over header bytes |

4. Verifier: split the sample into an **induction set** (used to generate the field hypotheses in step 3) and a **held-out set** from a different, unseen region of the disk. Accept the schema only if it decodes the held-out set at coverage ≥ 95 % and consistency ≥ 95 % — never re-validate against the same bytes it was induced from, which would risk accepting a schema that overfits that one sample instead of generalising across the disk. Fall back to raw AU carving grouped by `sps_fp` on failure.
5. Emit `schema.json` + `.ksy` (Kaitai) for examiner review; store in schema library with provenance.
6. Full-disk decode at disk speed → UFR.

**Headline demo:** on a Dahua/CP Plus disk with the Dahua adapter **switched off**, recover the DHAV
layout blind (magic, type, channel, frame no., length, packed date, ext-length, footer) and compare
with FFmpeg `dhav.c`; report field F1 and frame recall vs the adapter.

Novel points (scoped): **N** — codec-anchored field inference applied to surveillance storage, with
codec-coupled tests (resolution equality, NAL-type flag). Prior art to cite: BinaryInferno (NDSS 2023),
BinPRE (CCS 2024), FLINT (JNCA 2026), ESWA 2025 header identification.

---

### M4 — Recovery & reconstruction

**Output:** per-channel MP4 with real PTS; recovery table (`live` / `deleted` / `ambiguous`).

Must
1. **Live vs deleted:** `allocated` iff referenced by a live index entry. Without index: ring-buffer **write frontier** (largest backward time discontinuity in disk order) ⇒ residue outside the live run.
2. **Runs:** split at delimiters, channel changes, `sps_fp` changes, time breaks > k·GOP.
3. **Continuity check:** `frame_num`/POC continuity and IDR period; classify gaps.
4. **Remux** with `-c copy` into MP4, PTS from time (raw until M6); sidecar JSON with source byte ranges.

Nice — channel attribution when the channel field is missing (e.g. Honeywell after format)
- main vs sub stream by resolution;
- **colour-mode detection** (day colour vs night IR mono: chroma energy of the IDR) — day and night runs of a camera matched separately;
- constraints: time-overlapping runs ⇒ cannot-link; run starting ≤ 1 GOP after another with same `sps_fp` ⇒ must-link;
- scene signature of one IDR per run (grayscale edge-map / perceptual hash), constrained clustering;
- PTZ cameras and near-identical corridors ⇒ `ambiguous`, never guessed.

Roadmap: label transfer from post-format live footage; orphan SPS/PPS synthesis (Automatic Generation of H.264 Parameter Sets, arXiv 2104.14522); PRNU tie-breaker.

---

### M4.5 — Recovery validation & quality gate (Must)

**Why this module exists:** M4 can hand M7 a clip that is technically "recovered" but not really watchable —
an orphan fragment with a synthesised parameter set that decodes to garbage, a run cut short mid-GOP, a
channel-attribution result marked `ambiguous`. Running face or object detection on that footage produces
detections that look real in the report but come from decode noise. This module is the checkpoint between
recovery and analysis that stops that from happening silently — without it, "deleted footage recovered"
in M9 could quietly mean "recovered but never actually verified as playable."

**Input:** every clip and status from M4 (`live` / `deleted` / `ambiguous` / `orphan-repaired`).
**Output:** the same clip list, each tagged `passed` or `excluded(reason)`, forwarded to M7 and M9.

1. **Decode check:** attempt to decode 3 sample frames per run — first, middle, last (PyAV/FFmpeg). Record decoder errors, corrupt-macroblock warnings, and whether the last frame reached matches the expected run length.
2. **Continuity score:** dropped-frame ratio from the `frame_num`/POC check already computed in M4 step 3; below threshold ⇒ `excluded(low_continuity)`.
3. **Repair confidence:** `orphan-repaired` clips get an extra flag — synthesized-parameter-set clips are downgraded to "playable, not verified for pixel accuracy" and excluded from face/object detection by default (they may still be watched by an examiner).
4. **Routing:**
   - `passed` → M7, carrying its M4 status tag (`live`/`deleted`/`repaired`) so every detection in the report can say *where* the footage it came from stood — e.g. "object detected in **deleted** footage recovered from unallocated space."
   - `excluded(reason)` → skipped by M7, but **still listed in M9** as "recovered, not analysed — `reason`," so nothing silently disappears from the record.

Novel points: **E** — a small, deliberate checkpoint, not a research claim. It exists because M4's recovery methods (orphan repair, ambiguous channel attribution) can produce clips that are not safe inputs for face/object detection, and every published DVR-recovery paper we found (Rzayeva 2025, CARVE 2026, Yoon & Hwang 2026) reports *recovery* rates but not whether recovered footage was then *validated* before being analysed.

---

### M5 — Deletion & anti-forensic analysis (Differentiator 2)

**Output:** findings `{type, time_window, channels, evidence[], confidence}`.

1. Deletion-type classifier (Yoon & Hwang Table 2, generalised; thresholds calibrated on our own controlled disks):

| Observation | Inference |
|---|---|
| index/header reset, write pointer back at data start, residue **after** new data | formatting |
| index start time advanced, free space increased, residue **before** live data | expiration |
| disk full, free space ≈ constant, oldest removed | overwrite (ring) |
| disk/partition GUID or table checksum changed | re-initialisation |

2. **Format-time window:** `(t of last residue frame, t of first post-format frame)` → converted to UTC ± σ by M6.
3. **Log ↔ video contradictions:** recording gap without stop/video-loss/reboot log; logged recording with no footage and no expiry; log sequence/time going backwards; clock jump in video without logged time-set.
4. Per-channel hidden-interval report (index/record-state hours vs data present).

Novel points: **N** — deletion type + bounded format window are listed as future work by Yoon & Hwang 2026; log↔video cross-validation (Dragonas 2023/24 analysed logs alone).

---

### M6 — Timestamp normalisation (Differentiator 3, simplified)

**Output:** `t_utc ± t_sigma` per frame, clock-segment table, tamper flags with provenance.

6.1 Witnesses and **independence**

| Witness | Source | Independent of W1? |
|---|---|---|
| W1 | container/wrapper time (recorder clock) | — |
| W2 | burned-in OSD | **analog DVR: no** (drawn by the recorder from the same clock) · IP camera OSD: **yes** (camera clock) |
| W3 | index/log times, time-set & NTP-sync events | partly (same clock, but logs record *changes*) |
| W4 | seizure anchor photo vs NTP reference | yes |
| W5 | external anchors: known real-world events visible in footage (sunrise/sunset brightness, streetlights on/off) | yes (coarse) |

Rule: tamper flags **only between independent witnesses**; every flag states which two clocks disagreed.

6.2 Encoding & timezone: decode per `t_enc`; `local_naive` / `dahua_packed_local` converted with the recorder TZ/DST from the SOP (§M0.6) — verified per vendor on real disks.

6.3 OSD OCR: per-channel ROI (datetime regex, changes ~1 s); 1 frame/s; PaddleOCR rec-only; robust (RANSAC/Huber) fit vs W1 — isolated residual > 1.5 s = misread (corrected + flagged); sustained deviation = clock event.

6.4 Clock model: piecewise `t_true = t_raw + o_k + d_k·(t_raw − t_k)`; breakpoints = logged time-set/NTP events ∪ change-points; absolute offset from W4 (±1 s), additional anchors from logged NTP syncs and W5; σ = residual ⊕ anchor error ⊕ extrapolation term (grows with distance from nearest anchor — shown honestly, not hidden).

Stretch: ENF from lighting flicker (Frijters et al., JFS 2022) as extra absolute anchor.
Roadmap: cross-camera offset graph with loop-closure consistency.

Novel points: **N** — per-timestamp uncertainty with explicit witness provenance for CCTV (answers Vanini 2024 time anchors, Breitinger 2025 timeline SoK); **A** — sequence-constrained OSD OCR.

---

### M7 — Analytics (Must: basic detection · Nice: triage & refinements)

**Input:** every `passed` clip from **M4.5** — this explicitly includes recovered **deleted** and
**repaired** footage, not just newly-extracted live footage. Each detection keeps the clip's M4 status
tag, so the report can distinguish "seen in live footage" from "seen in footage recovered from
unallocated space."

**Which model runs each task:**

| Task | Model | Runs on | Why this one |
|---|---|---|---|
| Motion | OpenCV `MOG2` / `CNT` background subtraction | inside triage windows (Nice) or sampled frames (Must, pre-triage) | already in Niriksha; cheap, no GPU |
| Object detection | **RF-DETR Nano**, ONNX Runtime on CPU (RF-DETR Base optional, on demand, for a flagged window an examiner wants re-checked at higher accuracy) | 1–2 fps inside triage windows once triage exists; 1 fps disk-wide until then | Niriksha's existing choice was RF-DETR **Base on every frame** (bug B9) — too slow on CPU for a 24 h/channel disk; swapping to Nano alone saves ~3–5×, but **gating by triage windows is what makes CPU-only operation realistic**, saving orders of magnitude more |
| Face detection & clustering | `face_recognition` (dlib HOG) + DBSCAN, on **full-resolution** person crops (not the 0.25× downscale in bug B8, which loses small CCTV faces) | full-res crops from detected persons | existing Niriksha library; fixed to not destroy the very faces it should catch |
| Enhancement | deterministic multi-frame registration + averaging (real pixels only); GAN (Upscayl) kept, but watermarked "illustrative — not for identification" | on demand | GAN super-resolution invents detail — indefensible as evidence on its own |

**Must — basic detection (this is the PS's "Machine Learning" module; build it even before triage exists):**
1. Run motion → RF-DETR Nano → face detection per the table above, at a fixed 1 fps sample if the triage gate (below) isn't built yet; rows `Detection{frame_ref, t_utc, t_sigma, camera, class, conf, box, clip_status}`.
2. Faces are **leads, not identification** — stated in the UI and the report, every time.

**Nice — speed and accuracy refinements around the Must-tier detection:**
3. **Frame-size triage:** per channel per second, bytes of non-key frames from UFR; z-score against a baseline **normalised per channel and per day/night period** (IR noise inflates night P-frames). Detect and flag encoder modes where triage is unreliable: **CBR**, **H.264+/H.265+/Smart Codec** (variable GOP, background bitrate cuts) ⇒ fall back to sampled decoding for that channel.
4. **Never silently skip:** the report lists which windows were checked by which method and which were not checked, and which clips M4.5 excluded before reaching here.
5. **Cross-camera correlation (cheap):** for two cameras, flag detections of the **same class within a short time window** on the already-normalised UTC timeline (M6) as a *possible* same-event pair in a correlation table — no re-identification model, just class + time proximity. Coarse (produces false pairs on a busy scene) but it is the PS's "correlate events across cameras" requirement met without new ML; the accurate version (appearance-embedding hand-offs feeding the M6.4-style offset graph) stays on the Roadmap.
6. **Model evaluation:** benchmark **D-FINE** (Apache 2.0, ICLR 2025 Spotlight — beats RF-DETR-class models on the COCO AP/GFLOPs frontier when trained with **DEIM**, CVPR 2025) against RF-DETR Nano, measured on **CPU**, inside triage windows, on our own footage. Swap only if it wins on wall-time and recall: RF-DETR Nano is already integrated and working, D-FINE is not, and no source publishes CPU-only numbers for either at Nano/small size — this is a measurement task, not an assumption. **YOLO26** (Jan 2026) is the fastest CPU option specifically, but AGPL-3.0 — only worth this evaluation if Niriksha ships open-source; closed distribution needs Ultralytics' paid Enterprise licence.
7. **Measure:** frames processed & wall time vs full decode; event miss rate of triage on annotated footage.

Novel points: **A** — codec-level triage (compressed-domain CV: CompViT 2026, CoViAR) as DVR whole-disk gate with a measured miss rate; running analytics with the recovery-status tag preserved so a detection's provenance (live/deleted/repaired) is never lost.

---

### M8 — Clip manifests (Must, simple)

`clip.mp4.manifest.json`: `{evidence_md5, evidence_sha256, source_ranges, parser/schema_id + sha256, tool_version, engine_sha256, params, derived_sha256, t_utc_range, sigma, audit_hash}`.
`engine verify` re-extracts from the image and re-hashes. Roadmap: Merkle inclusion proofs (verification without the full image).

---

### M9 — Reporting (Must)

PDF + JSON + draft **BSA 2023 §63(4) certificate** (Schedule: Part A by party, Part B by expert, hash values).
Sections: case/examiner · device ID · acquisition & hashes · methods & parser/schema versions (`.ksy` appendix) · recovered footage (live/deleted/ambiguous) · deletion findings · timeline with σ and flags (with witness provenance) · analytics leads + unchecked windows · limitations · manifests · audit trail.

---

### M10 — CABM (Roadmap / research slide)

Hierarchical byte transformer (~20–40 M params) with heads for byte-role tagging, stream embedding and
bitstream activity; trained with **parsers as teachers** + **domain-randomised synthetic wrappers**;
inference once per disk on sampled records → schema vote → M3 verifier decides. Closest prior work:
ByteFormer (TMLR 2024), BLT (ACL 2025), ByteAction (arXiv 2608.22760), VBBM/BLMSP (arXiv 2608.21837).
Presented as future work; the statistical M3.2 is its baseline.

---

## 4. Data & validation

### 4.1 Real disks — start this week (decides success)
1. Buy 2–3 used recorders: **CP Plus**, **Dahua or Hikvision**, plus **Uniview or Godrej** if possible.
2. Controlled protocol (after Yoon & Hwang):
   `blank-wipe → set clock deliberately wrong → record (known events, clap/light switch) → change time mid-recording → image → format → record → image → let expiry/overwrite run → image`.
   Keep a written experiment log with reference (NTP) times for every action.
3. One disk set gives ground truth for M3/M5/M6, the **OEM comparison deliverable**, the validation report, and the answer to "tested on what?".
4. Verify, don't assume: does CP Plus write DHAV? Godrej? Matrix? TP-Link? Does the recorder store local time as pseudo-epoch?
5. Vendors we cannot get real hardware for (likely TP-Link, and whichever of Matrix/Godrej we don't buy) are still covered in the **OEM comparison deliverable** through desk research — public teardown reports, firmware documentation, spec sheets — stated plainly as *not validated on hardware*, distinct from the vendors we actually image. If a sample disk image or firmware dump turns up online, M3 attempts blind schema induction on it the same way as the purchased units.

### 4.2 Datasets
| ID | Content | Ground truth |
|---|---|---|
| D1 | Hikvision images (have) | fixed Niriksha parser |
| D2 | own controlled disks (§4.1) | experiment log |
| D3 | synthetic images (Honeywell layout, DHAV, PS) with scripted deletions — **labelled synthetic** | by construction |

### 4.3 Metrics
| Module | Metric |
|---|---|
| M3 | field-role F1 (Dahua blind), frame recall/precision vs adapter |
| M4 | deleted-frame recall; playable-clip rate; % ambiguous |
| M5 | deletion-type accuracy; format-window coverage & width |
| M6 | timestamp error (s) before/after vs NTP log; σ calibration (errors within ±2σ) |
| M7 | frames processed & time vs full decode; triage miss rate; RF-DETR Nano vs D-FINE — CPU wall-time and recall inside triage windows |
| M8 | tamper detection on bit-flipped clips = 100 % |
| End-to-end | wall-clock time, disk image → finished report, this pipeline vs current Niriksha vs a manual multi-tool workflow |

Baselines: Niriksha as-is; raw NAL carving; Rzayeva 2025 reported figures (different data — reference only).

---

## 5. Scope & schedule (~10 weeks to the Grand Finale)

| Week | Must | Differentiators | Nice |
|---|---|---|---|
| 1 | P0 bugs B1–B10; M0 hashing + audit chain; **buy recorders, start protocol** | — | — |
| 2–3 | UFR store; M3.0 PS demux; M3.1 codec scan; Hikvision → UFR; M4 per-channel MP4 | — | — |
| 4–5 | Dahua/CP Plus adapter; M1 basic; **M7 basic detection (motion+RF-DETR Nano+face, bugs B8/B9 fixed, 1 fps sample, no triage yet)** | **D1:** M3.2 induction, Dahua blind demo | — |
| 6–7 | M9 report + §63 draft; M8 manifest; **M4.5 validation gate** | **D2:** M5 on own disks · **D3:** M6 W1+W4+log events+OSD OCR | M7 triage gate + D-FINE eval |
| 8–9 | integration, SOPs, user manual | validation runs, metrics | M4 channel attribution; cross-camera correlation (cheap) |
| 10 | demo hardening: one image → report end to end | validation report, OEM comparison | — |

**Roadmap slide (not built):** CABM, cross-camera offset graph, Merkle per-clip proofs + RFC 3161, orphan SPS/PPS repair, label transfer, ENF anchors, Honeywell on real hardware.

---

## 6. Problem-statement coverage

| Requirement | Module(s) |
|---|---|
| Identify DVR models | M1 |
| Parse proprietary FS / decode formats | M2, M3 |
| Forensic images | M0 |
| Extract video & metadata | M3, M4 |
| Recover deleted footage | M2, M4, M5 |
| Normalise timestamps | M6 |
| MD5 + SHA-256 | M0, M8 |
| Correlate events across cameras | M6 common UTC timeline (Differentiator) + M7 step 5 class/time correlation table (Nice) + M7 step 6/roadmap appearance-based offset graph (accurate version) |
| Chain of custody | M0 audit chain, M8 |
| Reports | M9 |
| Machine Learning / face / object / motion | **M7 basic detection — Must**, per the tiering correction in §1 (only on clips M4.5 marks `passed`) |
| ≥ 5–6 OEMs | Hikvision, Dahua, CP Plus (verify DHAV), + Uniview/Godrej/Matrix via M3 on real disks; Honeywell via synthetic image unless hardware obtained; TP-Link via desk research + induction-ready schema (§4.1) unless a sample turns up |
| Deliverables | OEM comparison (§4.1), forensic images (§4.1), architecture (this file), prototype, SOPs (M0, §4.1), validation report (§4.3), user manual, final report |

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| No real multi-vendor disks | §4.1 this week; synthetic D3 clearly labelled |
| Stream encryption (some Hikvision firmware) | detect & report; out of scope |
| Nested/variable wrappers defeat M3.2 | M3.0 standard containers first; bit-packed + ext-length tests; fallback raw AU carving |
| Local-time pseudo-epoch → wrong TZ | `t_enc=local_naive` + recorder TZ from SOP, verified per vendor |
| Dependent clock witnesses → false tamper flags | provenance per witness; flags only across independent clocks |
| Large σ from single anchor | extra anchors (NTP logs, real-world events); show σ honestly |
| Triage misses events (CBR, smart codec, IR noise) | per-channel day/night normalisation, mode detection, fallback, unchecked windows reported |
| Scene matching fails (IR switch, PTZ, twin corridors) | colour-mode split; `ambiguous` label |
| HIKBTREE diff yields nothing | treated as hypothesis H-M2 until verified |
| SSD NVRs (TRIM/wear levelling) | documented limitation |
| Over-claiming | scoped claims, "to our knowledge", prior art cited per module |

---

## 8. References

- Yoon & Hwang, *Forensic analysis of video data deletion and recovery in Honeywell surveillance file system*, FSI:DI 2026 / arXiv 2605.07430
- Giri, Yoon & Hwang, *CARVE*, DFRWS APAC 2026
- Rzayeva et al., Information 16(11):983, 2025 (Hikvision & Dahua recovery)
- *Forensic Video Recovery from Multi-Channel Analog DVR Systems (DHAV)*, Information 17(5):493, 2026
- Dragonas et al., Hikvision/Dahua logs, J. Forensic Sci. 2023, 2024
- Han et al., *Analysis of the HIKVISION DVR file system*, 2015
- FFmpeg `libavformat/dhav.c` (DHAV record layout)
- Chandler, Wick & Fisher, *BinaryInferno*, NDSS 2023
- *BinPRE: Enhancing Field Inference in Binary Analysis Based PRE*, ACM CCS 2024
- FLINT, JNCA 2026; adaptive header identification, ESWA 2025
- Vanini et al., *Was the clock correct?*, FSI:DI 49 (2024); Breitinger et al., *SoK: Timeline based event reconstruction*, FSI:DI 53 (2025)
- Frijters et al., *Use of ENF presence in video material for time estimation*, JFS 2022
- *Automatic Generation of H.264 Parameter Sets to Recover Video File Fragments*, arXiv 2104.14522
- CompViT, IJCV 2026; ByteFormer, TMLR 2024; BLT, ACL 2025; ByteAction arXiv 2608.22760; VBBM arXiv 2608.21837
- D-FINE: *Redefine Regression Task of DETRs as Fine-grained Distribution Refinement*, ICLR 2025 Spotlight (arXiv 2410.13842); DEIM: *DETR with Improved Matching for Fast Convergence*, CVPR 2025 (arXiv 2412.04234); RF-DETR (Roboflow, Apache 2.0, arXiv 2511.09554); LW-DETR, arXiv 2406.03459
- Bharatiya Sakshya Adhiniyam 2023 §63 and Schedule; Kaitai Struct
