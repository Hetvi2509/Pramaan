// ============================================================
// The terminology the assistant explains.
//
// This is the equivalent of the qubits-dealflow assistant's hand-written
// domain conventions in `app/prompt.py`: the part of the knowledge that
// introspection cannot produce. There, it was "*Minor columns are paise".
// Here it is what HIKBTREE is, why a clip can be "repaired", and what a
// Section 63 certificate has to say — the things a model otherwise explains
// in general CCTV terms rather than in terms of what this tool computed.
//
// Kept as data (not prose in the system prompt) for two reasons: the full set
// is far too long to inline on every request, and a tool call makes the
// definition the model answers from auditable in the task log.
// ============================================================

export interface Term {
  term: string;
  /** Other spellings the user might type. Matched case-insensitively. */
  aka?: string[];
  group: string;
  /** One sentence. What it is. */
  short: string;
  /** Two to four sentences, including where it surfaces in Pramaan. */
  detail: string;
}

export const GLOSSARY: Term[] = [
  // ---------- M0: acquisition and integrity ----------
  {
    term: "Forensic image",
    aka: ["disk image", "bit-for-bit copy", "evidence image"],
    group: "Acquisition and integrity",
    short: "A sector-for-sector copy of the whole DVR hard disk, including the empty space.",
    detail:
      "Analysis is never run on the original disk — it is run on an image, so the exhibit stays unchanged and the work can be repeated by the other side. Unlike copying files, an image also captures unallocated space, which is where deleted recordings still live. In Pramaan an image is what you upload on the Evidence screen; everything else on the case traces back to it.",
  },
  {
    term: "Write blocker",
    aka: ["write-blocker", "WB", "hardware write blocker"],
    group: "Acquisition and integrity",
    short: "A device between the disk and the workstation that physically allows reads but refuses writes.",
    detail:
      "Plugging a suspect disk straight into a computer lets the operating system mount it and touch timestamps, which is a defensible objection in court. A write blocker makes that impossible at the hardware level. The Acquisition screen expects one and records whether it was in place.",
  },
  {
    term: "E01",
    aka: ["EWF", "Expert Witness Format", ".E01", "Ex01"],
    group: "Acquisition and integrity",
    short: "The Expert Witness Format: a compressed forensic image that stores its own hashes and case metadata.",
    detail:
      "An E01 is a disk image plus a container: it carries the acquisition hash, examiner notes and segment checksums inside the file, so corruption is detectable rather than silent. Pramaan reads .E01, .Ex01 and plain .dd/.img/.raw. The reference image used in development is dvr_test_img.E01.",
  },
  {
    term: "dd image",
    aka: ["raw image", ".dd", ".img", ".raw"],
    group: "Acquisition and integrity",
    short: "A plain uncompressed image: the disk's bytes in a file, with nothing added.",
    detail:
      "Simpler and more portable than E01, but it carries no internal hash or metadata, so integrity has to be tracked separately — which is what the case's hash record and audit trail are for.",
  },
  {
    term: "SHA-256",
    aka: ["sha256", "hash", "checksum", "digest"],
    group: "Acquisition and integrity",
    short: "A 64-character fingerprint of a file; any single changed bit produces a completely different value.",
    detail:
      "It is how Pramaan proves an exhibit has not changed between acquisition and report: the hash computed at intake is recorded, and re-hashing later must give the same string. Every uploaded evidence file is hashed on upload, and the value is shown on the Evidence screen and reprinted in the report. MD5 is computed alongside it only because older case records and tools quote MD5.",
  },
  {
    term: "Hash verification",
    aka: ["verify hash", "integrity check", "re-hash"],
    group: "Acquisition and integrity",
    short: "Re-computing a file's hash and comparing it to the value recorded at intake.",
    detail:
      "A match means the evidence is byte-identical to what was seized; a mismatch means the exhibit is no longer trustworthy and must be reported as such rather than analysed quietly. In Pramaan a verified item shows a green seal on the Evidence screen.",
  },
  {
    term: "Chain of custody",
    aka: ["custody", "custody chain"],
    group: "Acquisition and integrity",
    short: "The unbroken record of who held the evidence, when, and what they did to it.",
    detail:
      "Each handover, each tool run and each derived file needs a time, an actor and a hash, or the defence can argue the evidence could have been altered in the gap. Pramaan's audit trail is this record: every action is appended with its target and hash, and the report includes it.",
  },
  {
    term: "Audit trail",
    aka: ["audit log", "audit"],
    group: "Acquisition and integrity",
    short: "The append-only list of every action taken on the case, each stamped with actor, time and hash.",
    detail:
      "It exists so that nothing in the report is asserted without a way to re-derive it, and so that a skipped or failed step is visible rather than silent. The Audit screen shows it for the case.",
  },
  {
    term: "Section 63 certificate",
    aka: [
      "section 63",
      "s63",
      "bsa 63",
      "bsa section 63",
      "63(4)",
      "certificate",
      "bharatiya sakshya adhiniyam",
    ],
    group: "Legal",
    short:
      "The certificate under Section 63 of the Bharatiya Sakshya Adhiniyam, 2023 that makes electronic evidence admissible in an Indian court.",
    detail:
      "It is a signed statement describing the device the record came from, the process that produced the output, and the fact that the computer was operating properly — without it, the electronic record is generally not admissible. Section 63 of the BSA (in force since 1 July 2024) replaces Section 65B of the Indian Evidence Act, 1872, which is the older name you will still see in case papers. Pramaan drafts this certificate on the Report screen from the case's own hashes, tool versions and audit trail; it is a draft for the examiner to check and sign, not a signature.",
  },
  {
    term: "Section 65B",
    aka: ["65b", "s65b", "indian evidence act 65b"],
    group: "Legal",
    short: "The predecessor of Section 63 BSA — the electronic-evidence certificate under the Indian Evidence Act, 1872.",
    detail:
      "Repealed with the rest of the Evidence Act when the Bharatiya Sakshya Adhiniyam, 2023 came into force on 1 July 2024. Older cases, judgments and police formats still refer to it, so the two names describe the same requirement at different times. Pramaan drafts the current form, Section 63.",
  },

  // ---------- M1/M2: DVR internals ----------
  {
    term: "DVR",
    aka: ["digital video recorder"],
    group: "DVR internals",
    short: "The box that records analogue CCTV cameras to its own hard disk.",
    detail:
      "Almost every DVR writes to a proprietary layout of its own rather than to FAT or NTFS, which is why a seized DVR disk looks empty to Windows and needs a tool like this one. An NVR is the same idea for IP cameras over a network.",
  },
  {
    term: "NVR",
    aka: ["network video recorder"],
    group: "DVR internals",
    short: "A network video recorder: the same function as a DVR, but recording IP cameras over the network.",
    detail:
      "The on-disk layouts overlap heavily with the DVR families, so the same parsers usually apply.",
  },
  {
    term: "Channel",
    aka: ["ch", "camera channel"],
    group: "DVR internals",
    short: "One camera input on the recorder, numbered CH 01 upwards.",
    detail:
      "Recovery, timeline and correlation are all organised per channel, because a DVR interleaves every camera's frames on the same disk and the index is what separates them again.",
  },
  {
    term: "Proprietary file system",
    aka: ["custom file system", "vendor file system"],
    group: "DVR internals",
    short: "A disk layout invented by the DVR manufacturer instead of a standard one like NTFS or ext4.",
    detail:
      "There is no public specification for most of them, so each vendor family needs its own parser (Hikvision's HIKBTREE, Dahua's DHFS) and an unknown vendor needs schema induction or carving. This is the single reason DVR recovery is harder than ordinary disk recovery.",
  },
  {
    term: "Master sector",
    aka: ["master sector header", "superblock"],
    group: "DVR internals",
    short: "The first structure on a Hikvision disk: capacity, offsets and where the other structures live.",
    detail:
      "Parsing it is step one, because it is what points at the system log area and the recording index. Pramaan shows each field with its byte address and raw bytes on the Data Viewer screen, so a reader can check the parse against the disk rather than take it on trust.",
  },
  {
    term: "HIKBTREE",
    aka: ["hikbtree1", "hikbtree2", "hik btree", "btree"],
    group: "DVR internals",
    short: "Hikvision's recording index: a B-tree listing every recorded segment, its channel, and its time range.",
    detail:
      "It is the catalogue that turns an undifferentiated mass of video blocks into named recordings per channel, so it is the structure recovery depends on most. There are two copies (HIKBTREE1 and HIKBTREE2); the second is a fallback when the first has been damaged. Pramaan parses it in backend/engine/dvr_scan/hikvision/hikbtree.py and shows the header fields with their addresses in the Data Viewer.",
  },
  {
    term: "IMKH",
    aka: ["imkh header"],
    group: "DVR internals",
    short: "The four-byte signature at the start of a Hikvision video block.",
    detail:
      "Finding IMKH blocks is how video data is located even when the index is gone — it is the anchor for carving on a Hikvision disk. The video inside is MPEG program stream.",
  },
  {
    term: "MPEG-PS",
    aka: ["mpeg program stream", "program stream", "ps"],
    group: "DVR internals",
    short: "MPEG program stream: the container Hikvision wraps its video blocks in.",
    detail:
      "Because it is a standard container, a recovered block can be remuxed to a playable MP4 without re-encoding, which matters forensically: the pixels in the exported clip are the pixels from the disk.",
  },
  {
    term: "DHAV",
    aka: ["dhav record", "dhav header"],
    group: "DVR internals",
    short: "Dahua's video record format, marked by a 'DHAV' magic at the start and 'dhav' at the end of each record.",
    detail:
      "Every record carries its own channel, frame type and packed timestamp, which makes Dahua disks carvable even without the index. CP Plus recorders are usually rebranded Dahua, so they are expected to use the same records — expected, because Pramaan has not yet had a CP Plus disk to confirm it on, and the OEM screen says so.",
  },
  {
    term: "DHFS",
    aka: ["dahua file system"],
    group: "DVR internals",
    short: "Dahua's file system: the superblock and index that catalogue DHAV records.",
    detail:
      "The DHFS superblock magic at offset 0 is what identifies a disk as the Dahua family, which is how the Device ID screen picks a parser.",
  },
  {
    term: "System log",
    aka: ["rats log", "rats", "dvr log", "system logs"],
    group: "DVR internals",
    short: "The recorder's own event log, held in a reserved area of the disk.",
    detail:
      "It records power cycles, disk formats, configuration changes and recording start/stop, each with a timestamp — which makes it the main independent check on the video. Pramaan parses 12,245 entries from the reference image; a log entry that contradicts the video is exactly what the Deletion screen looks for.",
  },
  {
    term: "I-frame",
    aka: ["idr", "idr frame", "keyframe", "key frame", "intra frame"],
    group: "DVR internals",
    short: "A self-contained video frame that can be decoded on its own, without reference to any other frame.",
    detail:
      "Every other frame type only stores the difference from its neighbours, so recovery and seeking both have to start at an I-frame (strictly, an IDR frame in H.264/H.265). A recovered fragment that contains no I-frame cannot be decoded into a picture at all, which is one of the things the decode gate catches.",
  },
  {
    term: "GOP",
    aka: ["group of pictures"],
    group: "DVR internals",
    short: "A group of pictures: one I-frame plus the dependent frames that follow it.",
    detail:
      "The GOP is the smallest unit that can be recovered intact, so GOP length sets how precisely a clip can be cut and how much is lost around damage.",
  },
  {
    term: "Allocated and unallocated",
    aka: ["allocated", "unallocated", "unallocated space", "free space"],
    group: "DVR internals",
    short: "Allocated space is what the index still claims; unallocated is space the recorder considers free.",
    detail:
      "Deleting or formatting usually only clears the index, leaving the video itself in unallocated space until it is overwritten. That is why deleted footage is recoverable at all, and why an image has to be taken of the whole disk rather than of its files.",
  },
  {
    term: "Carving",
    aka: ["file carving", "data carving", "carve"],
    group: "Recovery",
    short: "Recovering video by scanning the raw disk for format signatures, ignoring the index entirely.",
    detail:
      "It is the fallback when the index is destroyed or the vendor is unknown: find every IMKH, DHAV, H.264 or H.265 start pattern and rebuild clips from the frames themselves. The cost is metadata — carved clips have weaker time and channel attribution than indexed ones, so Pramaan labels where a clip came from instead of mixing the two.",
  },
  {
    term: "Schema induction",
    aka: ["induction", "blind induction", "schema discovery"],
    group: "Recovery",
    short: "Working out an unknown recorder's record layout from the disk's own repeating patterns.",
    detail:
      "For vendors with no published layout and no imaged disk (TP-Link, Godrej, Uniview, Matrix on the OEM screen), there is no parser to write, so the engine infers field positions from recurring structure and timestamp-shaped integers. It produces a weaker, explicitly lower-confidence result than a validated parser, and the OEM screen marks those vendors 'Induction only'.",
  },
  {
    term: "Unified Frame Record",
    aka: ["ufr", "unified frame", "frame record"],
    group: "Recovery",
    short: "Pramaan's vendor-neutral description of one discovered frame: channel, time, offset, type, size and provenance.",
    detail:
      "Each vendor parser and the carver all emit this same record, so everything downstream — recovery, timeline, deletion analysis, analytics — is written once against one shape rather than per vendor. It is the output of module M3.",
  },
  {
    term: "Pseudo-epoch",
    aka: ["epoch", "packed timestamp", "vendor epoch"],
    group: "Time",
    short: "A vendor's own way of packing a date and time into an integer, which is not the Unix epoch.",
    detail:
      "Hikvision counts from its own zero point and Dahua packs the fields as a bitfield, so reading either as a Unix timestamp gives a date decades off. Worse, the value is usually the recorder's local wall clock with no zone recorded, which is why time normalisation is a separate module and not a format conversion.",
  },

  // ---------- M4 / M4.5: recovery and validation ----------
  {
    term: "Live footage",
    aka: ["live", "live clip"],
    group: "Recovery",
    short: "Footage the recorder's index still claims — present and never deleted.",
    detail:
      "The strongest category, because both the index and the video agree. Shown in teal throughout Pramaan.",
  },
  {
    term: "Deleted footage",
    aka: ["deleted", "deleted clip"],
    group: "Recovery",
    short: "Footage recovered from space the recorder had released — the index no longer lists it.",
    detail:
      "Recoverable because deletion normally clears the index and not the video. Attribution is weaker than for live footage, so the clip's time and channel carry how they were derived. Shown in amber.",
  },
  {
    term: "Repaired footage",
    aka: ["repaired", "repaired clip", "reconstructed"],
    group: "Recovery",
    short: "A clip reassembled from fragments, with damaged or missing parts worked around.",
    detail:
      "Repair is a reconstruction, so the clip is not a pristine copy of what the camera saw and must be presented that way: Pramaan records continuity as a percentage and keeps the repair visible rather than producing a seamless-looking file. Shown in indigo.",
  },
  {
    term: "Excluded footage",
    aka: ["excluded", "failed gate"],
    group: "Recovery",
    short: "A recovered clip that failed the quality gate and is deliberately kept out of analysis.",
    detail:
      "Excluding is a result, not a failure to report: a clip that will not decode cleanly would produce detections nobody can defend. Pramaan lists excluded clips with the reason rather than dropping them silently.",
  },
  {
    term: "Decode gate",
    aka: ["m4.5", "quality gate", "gate", "recovery validation"],
    group: "Recovery",
    short: "Module M4.5: every recovered clip is actually decoded and measured before analytics may use it.",
    detail:
      "The check is empirical — the clip is decoded frame by frame and scored on how much decoded without error, rather than assumed good because the parser emitted it. Clips that pass are eligible for motion, object and face analysis; clips that fail are marked excluded with the reason. The result is stored per extraction as extraction_<id>.gate and shown on the Recovery screen.",
  },
  {
    term: "Continuity",
    aka: ["continuity percentage", "completeness"],
    group: "Recovery",
    short: "How much of a clip's claimed time range is actually present as decodable frames.",
    detail:
      "A clip can cover 02:00 to 02:10 on paper and hold four minutes of real frames; continuity is that ratio. It matters because a gap in the middle of a clip can look like nothing happened when in fact nothing was recorded.",
  },
  {
    term: "Transcode",
    aka: ["transcoding", "re-encode"],
    group: "Recovery",
    short: "Re-encoding video into a format a browser can play.",
    detail:
      "Needed only for preview: Pramaan transcodes on the fly for the player, while the exported evidence clip is remuxed without re-encoding so its pixels stay the disk's pixels. The preview is never the exhibit.",
  },
  {
    term: "Clip manifest",
    aka: ["manifest", "m8"],
    group: "Recovery",
    short: "The per-clip record of where it came from: source offsets, hash, time basis, gate result and tool version.",
    detail:
      "Module M8. It is what lets a clip in the report be re-derived from the original image by someone else, which is the difference between an exhibit and a video file.",
  },

  // ---------- M5: deletion and anti-forensics ----------
  {
    term: "Format window",
    aka: ["format time window", "format event"],
    group: "Deletion",
    short: "The time range within which the disk was formatted, with its uncertainty.",
    detail:
      "The exact moment is rarely recoverable, so Pramaan reports a window and a sigma rather than a single timestamp — on the reference case, 02:11 to 02:46 IST at ±1.4 s. A window that lands shortly after the incident is the finding; stating it as a precise time would overstate what the disk supports.",
  },
  {
    term: "Anti-forensics",
    aka: ["anti forensics", "tampering", "evidence destruction"],
    group: "Deletion",
    short: "Deliberate action taken to destroy or hide the recording — formatting, overwriting, clock changes.",
    detail:
      "Module M5 classifies how footage went missing and how confident that classification is, because 'deleted on purpose' and 'overwritten by normal rotation' are very different facts in a case. Both leave different traces in the index, the logs and the unallocated space.",
  },
  {
    term: "Overwrite",
    aka: ["overwritten", "rotation", "ring buffer"],
    group: "Deletion",
    short: "New recording written over old, which is what a DVR does normally when the disk fills.",
    detail:
      "Ordinary rotation destroys footage with no intent behind it, so distinguishing it from deliberate deletion is the central question in M5. Overwritten video is genuinely unrecoverable, unlike merely deleted video.",
  },
  {
    term: "Log-video contradiction",
    aka: ["contradiction", "log contradiction", "inconsistency"],
    group: "Deletion",
    short: "A place where the recorder's own log and the video on the disk cannot both be true.",
    detail:
      "The log saying recording was continuous while no frames exist for that window is evidence of removal, not of a quiet night. Pramaan lists contradictions alongside the supporting evidence on the Deletion screen, including the ones that weaken its own conclusion.",
  },
  {
    term: "Tamper flag",
    aka: ["tamper", "tamper indicator"],
    group: "Deletion",
    short: "A marker that something about a time or a recording cannot be trusted at face value.",
    detail:
      "Raised by clock changes, non-monotonic timestamps or index entries that disagree with the frames. Flagged times stay in the timeline with the flag attached rather than being dropped.",
  },

  // ---------- M6: time ----------
  {
    term: "Time normalisation",
    aka: ["m6", "normalisation", "normalization", "time mapping"],
    group: "Time",
    short: "Converting every recorder-local timestamp to UTC, with an explicit uncertainty on each one.",
    detail:
      "Module M6. A DVR clock is set by hand, drifts, and is stored in a vendor pseudo-epoch with no zone, so a raw timestamp is not a time — it is a reading that needs a correction and an error bar. Pramaan carries UTC ± sigma plus the provenance of the correction (a witness clock, an OCR'd overlay, a log event) for every time it prints.",
  },
  {
    term: "Sigma",
    aka: ["σ", "uncertainty", "error bar", "±"],
    group: "Time",
    short: "The uncertainty attached to a time: ±1.4 s means the true moment lies in that band.",
    detail:
      "Every time in Pramaan carries one, because a timestamp quoted to the second from a hand-set clock claims a precision the evidence does not have. Two events four seconds apart with a ±9 s uncertainty cannot be ordered, and the correlation screen refuses to order them.",
  },
  {
    term: "Clock drift",
    aka: ["drift", "clock error"],
    group: "Time",
    short: "The accumulating difference between the recorder's clock and real time.",
    detail:
      "DVR clocks are rarely synchronised and commonly run minutes or hours out after months of uptime. Drift is measured where an independent reference exists and then applied as a correction, which is where much of a timestamp's sigma comes from.",
  },
  {
    term: "Burned-in timestamp",
    aka: ["osd", "overlay", "on-screen display", "burned in time"],
    group: "Time",
    short: "The date and time the recorder draws into the video picture itself.",
    detail:
      "Being part of the pixels, it survives export and remuxing, which makes it a useful cross-check on the index's timestamps — the two coming from different parts of the recorder. Pramaan reads it with OCR on the OCR Analysis screen; it still reflects the same possibly-wrong DVR clock, so agreement proves consistency, not correctness.",
  },
  {
    term: "Witness provenance",
    aka: ["witness", "witness clock", "independent reference"],
    group: "Time",
    short: "Where a time correction came from, and whether that source is independent of the DVR.",
    detail:
      "A phone call record or a till receipt is independent evidence of when something happened; the DVR's own log is not. The Timeline screen marks each witness as independent or not and shows whether it agrees, is missing or conflicts, because a correction derived from the recorder cannot validate the recorder.",
  },

  // ---------- M7: analytics ----------
  {
    term: "Motion detection",
    aka: ["motion", "m7 motion", "dvr-scan"],
    group: "Analytics",
    short: "Finding the time ranges in a clip where the picture changes, to skip the empty hours.",
    detail:
      "Built on DVR-Scan's background-subtraction core. It is a triage tool, not a finding: it says where to look, and a human still decides what is there. Run from the Motion Detection screen on clips that passed the decode gate.",
  },
  {
    term: "Object detection",
    aka: ["objects", "yolo", "object"],
    group: "Analytics",
    short: "Labelling people, vehicles and bags in frames, each with a confidence.",
    detail:
      "Useful for finding the frames worth watching across hours of recovered footage. A label is a lead to verify by eye, and the Analytics screen keeps the confidence attached so a weak detection is not quoted as a fact.",
  },
  {
    term: "Face detection",
    aka: ["faces", "face grouping", "face recognition"],
    group: "Analytics",
    short: "Finding faces and grouping ones that appear to be the same person across clips.",
    detail:
      "Grouping is explicitly a lead, not an identification: CCTV resolution, angle and lighting are far from the conditions face recognition is reliable under, and Pramaan does not claim an identity. It tells an investigator which clips to watch together.",
  },
  {
    term: "Detection confidence",
    aka: ["confidence", "score"],
    group: "Analytics",
    short: "The model's own 0-100 certainty in one detection.",
    detail:
      "It measures how well the pattern matched, not how likely the claim is to be true in court, and it says nothing about whether the model was asked a sensible question. Always reported with the detection rather than filtered away.",
  },
  {
    term: "Upscaling",
    aka: ["upscale", "upscayl", "lanczos", "super resolution", "enhance"],
    group: "Analytics",
    short: "Enlarging a frame — either by interpolation (Lanczos) or with a generative model (Upscayl).",
    detail:
      "The distinction matters forensically. Lanczos only resamples pixels that exist. A GAN model invents plausible detail that was never recorded, which can produce a convincing face or number plate that is not evidence of anything. Pramaan offers both on the Image Upscaling screen and records which one produced a given output.",
  },
  {
    term: "Cross-camera correlation",
    aka: ["correlation", "same event", "camera pairing"],
    group: "Analytics",
    short: "Proposing that two detections on different channels are the same event.",
    detail:
      "Candidates are paired on class and time proximity, with the gap in seconds shown. They are proposals: with per-channel clock offsets and sigma on each time, a nine-second gap may mean 'the same person walking' or may mean nothing, so the screen presents pairs for an examiner to accept rather than asserting them.",
  },

  // ---------- pipeline ----------
  {
    term: "M0 to M9",
    aka: [
      "m0",
      "m1",
      "m2",
      "m3",
      "m4",
      "m5",
      "m6",
      "m7",
      "m8",
      "m9",
      "modules",
      "pipeline",
      "pipeline modules",
    ],
    group: "Pipeline",
    short: "The ten pipeline stages Pramaan is organised around, from intake to report.",
    detail:
      "M0 intake (hash and audit), M1 identify (vendor, model, disk), M2 file-system and index parse, M3 frame discovery and schema induction, M4 recovery and reconstruction with M4.5 the decode gate, M5 deletion and anti-forensics, M6 time normalisation, M7 analytics, M8 clip manifests, M9 report with the BSA Section 63 draft. Every screen in the app belongs to one of them, and every derived artefact traces back through the chain to the image's hash.",
  },
  {
    term: "Device identification",
    aka: ["m1", "identify", "device id", "vendor identification"],
    group: "Pipeline",
    short: "Module M1: deciding which recorder family wrote the disk, and showing why.",
    detail:
      "The decision rests on structural signatures found on the disk — a DHFS superblock magic, how many records the candidate schema explains — not on the model name string, which is only read as text and can be wrong or absent. Pramaan shows the competing candidates with scores and lists the signatures it did not find, so a 96% fit can be argued with.",
  },
  {
    term: "FIR",
    aka: ["first information report", "f.i.r", "fir number"],
    group: "Legal",
    short: "The First Information Report: the police record that registers a cognisable offence and starts an investigation.",
    detail:
      "Every Pramaan case is tied to one, and the FIR number is the reference that appears on the report and the Section 63 certificate. The dates in it (when the offence happened, when it was reported) set the window in which footage is likely to matter, which is why the Timeline screen is organised around a single day.",
  },
  {
    term: "Seizure memo",
    aka: ["panchnama", "seizure", "seizure list", "exhibit", "exhibit number", "mahazar"],
    group: "Legal",
    short: "The signed record, made before witnesses, of what was taken from the scene and in what condition.",
    detail:
      "For a DVR it should name the make, model, serial number and number of disks, because that description is what later proves the disk analysed is the disk seized. Pramaan's Device ID screen reads the same details from the disk itself so the two can be compared, and the chain of custody starts at this document.",
  },
  {
    term: "MD5",
    aka: ["md5 hash"],
    group: "Acquisition and integrity",
    short: "An older 32-character file fingerprint, still quoted in many police and lab records.",
    detail:
      "It is weaker than SHA-256 against deliberate tampering, so Pramaan computes both on intake and treats SHA-256 as the one that proves integrity. MD5 is kept only because older case papers and some tools still ask for it.",
  },
  {
    term: "UTC and IST",
    aka: ["utc", "ist", "time zone", "timezone", "gmt"],
    group: "Time",
    short: "UTC is the world reference time; IST is Indian Standard Time, UTC plus 5 hours 30 minutes.",
    detail:
      "Pramaan stores every time in UTC and lets you switch the display to IST on the Timeline, because a DVR clock is usually set to local time with no zone recorded and mixing the two is an easy way to be five and a half hours wrong. The report states which one it uses.",
  },
  {
    term: "H.264 and H.265",
    aka: ["h264", "h265", "hevc", "avc", "codec", "video codec"],
    group: "DVR internals",
    short: "The two video compression formats almost all DVRs record in; H.265 is the newer, smaller one.",
    detail:
      "Pramaan's carving looks for both when no vendor index is available. Because they are standard formats, a recovered stream can be decoded and checked by any independent tool, which is what the decode gate relies on.",
  },
  {
    term: "Frame rate",
    aka: ["fps", "frames per second"],
    group: "DVR internals",
    short: "How many pictures per second a camera records; CCTV is often 6 to 25.",
    detail:
      "A low frame rate means events between frames are simply not recorded, which limits what motion or object detection can find and is worth stating when a clip is used to show that something did not happen.",
  },
  {
    term: "Bitrate",
    aka: ["bit rate", "video quality"],
    group: "DVR internals",
    short: "How much data per second the video uses; lower means more compression and less detail.",
    detail:
      "DVRs often drop the bitrate on secondary channels to fit more days on the disk, so a clip can be legally intact and still too soft to read a number plate. That is a limit of the recording, not of recovery.",
  },
  {
    term: "Sector",
    aka: ["disk sector", "block", "offset", "byte offset", "hex offset"],
    group: "DVR internals",
    short: "The smallest unit a disk reads, usually 512 bytes; an offset is how far into the disk a structure starts.",
    detail:
      "Pramaan prints every parsed field with its byte address in decimal and hex so another examiner can open the same image in a hex editor, go to that address and see the same bytes.",
  },
  {
    term: "Magic number",
    aka: ["signature", "file signature", "magic bytes", "magic"],
    group: "DVR internals",
    short: "A fixed byte pattern at the start of a structure that says what it is, such as IMKH or DHAV.",
    detail:
      "Identification and carving both work by finding these patterns. A magic number alone can occur by chance in unrelated data, which is why Pramaan checks that the bytes after it parse correctly before counting it.",
  },
  {
    term: "OCR",
    aka: ["optical character recognition", "text recognition"],
    group: "Analytics",
    short: "Reading text out of a picture; here, the date and time the DVR draws on the video.",
    detail:
      "Run on the OCR Analysis screen to compare the burned-in clock with the index time. Characters can be misread, so each reading carries a confidence and nothing is accepted on a low one.",
  },
  {
    term: "Remux",
    aka: ["remuxing", "container conversion"],
    group: "Recovery",
    short: "Moving the video data into a different file container without re-encoding it.",
    detail:
      "How a recovered stream becomes an MP4: the picture data is copied unchanged, so the exported clip contains exactly what was on the disk. Re-encoding would change the pixels and weaken the exhibit.",
  },
  {
    term: "Case",
    aka: ["case record", "case file"],
    group: "Pipeline",
    short: "One investigation in Pramaan: its evidence images, results and audit trail.",
    detail:
      "Cases belong to the examiner who created them and cannot be read by anyone else. Each holds the evidence files with their hashes, everything parsed or recovered from them, and the report.",
  },
  {
    term: "Intake",
    aka: ["m0 intake", "evidence intake", "upload"],
    group: "Pipeline",
    short: "Module M0: receiving an evidence image, hashing it and opening the audit trail.",
    detail:
      "The point where the exhibit becomes verifiable. Everything later is checked against the hash taken here.",
  },
];

const MAX_RESULTS = 4;

function haystack(t: Term): string {
  return [t.term, ...(t.aka ?? []), t.group].join(" ").toLowerCase();
}

/**
 * Look a term up. Exact name/alias first, then substring, then a loose
 * word-overlap match so "what does repaired mean" still finds "Repaired
 * footage". Returns at most MAX_RESULTS so a vague query cannot flood the
 * model's context with the whole glossary.
 */
export function lookupTerm(query: string): Term[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const exact = GLOSSARY.filter((t) => t.term.toLowerCase() === q || (t.aka ?? []).some((a) => a.toLowerCase() === q));
  if (exact.length) return exact.slice(0, MAX_RESULTS);

  const substring = GLOSSARY.filter((t) => haystack(t).includes(q));
  if (substring.length) return substring.slice(0, MAX_RESULTS);

  const words = q.split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  if (!words.length) return [];
  const scored = GLOSSARY.map((t) => {
    const hay = haystack(t);
    return { t, score: words.filter((w) => hay.includes(w)).length };
  })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_RESULTS).map((s) => s.t);
}

/** Term names grouped by section — cheap enough to hand the model whole. */
export function termIndex(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const t of GLOSSARY) (out[t.group] ??= []).push(t.term);
  return out;
}
