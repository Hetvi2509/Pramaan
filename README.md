<p align="center">
  <img src="pramaan_logo.jpeg" alt="Pramaan logo" width="96" />
</p>

<h1 align="center">Pramaan</h1>
<p align="center"><b>Vendor-agnostic DVR / NVR digital forensics platform</b><br/>
SIH 2026 · Problem Statement 150</p>

---

## 1. What this is

CCTV DVRs/NVRs each store video in a different proprietary on-disk format (Hikvision, Dahua,
CP Plus, Honeywell, ...). An investigator who seizes one of these disks today needs a different,
often vendor-supplied tool per brand, with no standard way to recover deleted footage, normalise
timestamps across cameras, or produce a court-ready report with hash-verified chain of custody.

**Pramaan is one offline workstation that does all of it**, regardless of vendor:

1. **Image & hash** the disk (MD5 + SHA-256, hash-chained audit log).
2. **Identify** the vendor/family and **parse** its file system / index / logs.
3. **Recover** footage — live, deleted (from unallocated space), or repaired — per channel.
4. **Analyse** deletion patterns (formatted vs expired vs overwritten) and cross-check the
   recorder's logs against what the video itself shows.
5. **Normalise time** across cameras into UTC, with an explicit uncertainty (`± σ`) and which
   clock (recorder, OSD, logs, seizure photo) backs each timestamp.
6. Run **motion / face / object detection** on the recovered footage as investigative leads
   (never as identification).
7. Generate a **detailed, hash-verifiable PDF/JSON report** with a draft BSA 2023 §63(4)
   certificate, ready to hand to a court.

Everything runs **fully offline** — no evidence ever needs to leave the examiner's machine.

The full research plan, novelty claims and 10-week build schedule live in **[`plan.md`](plan.md)**;
this README documents the system as it is actually built.

---

## 2. Architecture

```mermaid
flowchart TB
    subgraph Client["Frontend — React 19 + TypeScript + Tailwind v4 (Vite, hash-router)"]
        UI["Case workspace UI\ncases · evidence · recovery · deletion\ntimeline · correlation · analytics · report\nmotion / OCR / faces / objects / upscale tools"]
    end

    subgraph Server["Backend — Node.js + Express + TypeScript"]
        API["REST API\nauth (JWT) · cases · evidence\nforensics data store · task runner"]
        DB[(SQLite via Prisma\nUsers · Cases · ImageFiles · ForensicsData)]
        SSE["Server-Sent Events\nlive task log + progress"]
    end

    subgraph Engine["Python forensic engine (spawned per task)"]
        CLI["dvr_scan CLI\n(python -m dvr_scan)"]
        Hik["Hikvision adapter\nmaster sector · HIKBTREE1/2 · system logs"]
        Forensics["forensics.py\nhash · identify · parse · extract · upscale"]
        Motion["Motion detection\nOpenCV MOG2/CNT background subtraction"]
        Faces["Face detection\nface_recognition (dlib) + DBSCAN clustering"]
        Objects["Object detection\nRF-DETR (nano/small/medium/base), batched inference"]
        OCR["OCR\nPaddleOCR — burned-in on-screen timestamps"]
        Upscale["Upscale\nLanczos or Upscayl GAN (watermarked, illustrative)"]
    end

    UI <-->|fetch / EventSource| API
    API --> DB
    API -->|spawn subprocess,\nstream stdout JSON lines| CLI
    CLI --> Hik
    CLI --> Forensics
    CLI --> Motion
    CLI --> Faces
    CLI --> Objects
    CLI --> OCR
    CLI --> Upscale
    CLI -.JSON lines over stdout.-> SSE
    SSE -.-> UI
```

**Why a subprocess engine instead of one Node app:** the forensic/ML stack (OpenCV, PyTorch,
RF-DETR, dlib, PaddleOCR, pytsk3) is Python-only and heavy; Node.js owns the API, database and
auth, and shells out to the Python engine (`python -m dvr_scan <subcommand> ...`) per task. The
engine streams progress as newline-delimited JSON on stdout, which the backend re-emits to the
browser over **Server-Sent Events** so long-running tasks (parsing a multi-GB image, running
object detection on a video) show live progress instead of blocking the request.

### 2.1 Forensic pipeline (the "M0–M9" modules)

```
 INPUT                                                                        OUTPUT
 .E01/.dd/.img/.raw ─┐
 physical disk (WB) ─┴► M0 Intake ─► M1 Identify ─► M2 FS/Index parse ─┐
                        MD5+SHA256,    vendor,        allocated frames │
                        audit chain    model, disk    + logs           ▼
                                        M3 frame discovery / schema induction ──► Unified Frame Record
                                                                                  │
                  ┌───────────────────────────────┬───────────────────────────────┤
                  ▼                               ▼                               ▼
          M4 Recovery & reconstruction    M5 Deletion/anti-forensics      M6 Time normalisation
          per-channel MP4, live vs         type + format-time window,      UTC ± σ, witness
          deleted vs repaired              log↔video contradictions        provenance, tamper flags
                  ▼
          M4.5 Recovery validation — decode-check + quality gate
                  └───────────────┬───────────────┴───────────────┬───────────────┘
                                  ▼                               ▼
              M7 Analytics (motion / object / face, on passing clips)  M8 Clip manifests
                                  └───────────────┬───────────────┘
                                                  ▼
                                   M9 Report: PDF + JSON + BSA §63 draft
```

Every derived artefact (a clip, a detection, a timestamp) traces back through this chain to the
original disk image's hash — nothing is asserted without a way to re-derive it.

### 2.2 What's real vs. what's a fixture today

This is a hackathon-stage build, not a finished product, and the UI is honest about the
difference on-screen. To read the codebase the same way:

| Layer | Status |
|---|---|
| Auth, cases, evidence upload + hashing (M0) | **Real** — Express + Prisma + SQLite, exercised end to end |
| Hikvision parsing (master sector, HIKBTREE, logs) (M1/M2) | **Real** — `backend/engine/dvr_scan/hikvision/` |
| Motion / OCR / face / object detection / upscale (M7) | **Real** — actually spawns the Python engine and runs the models |
| Report generation (M9) | **Real** — pulls live case/evidence/forensics data, renders a print-ready PDF (browser print-to-PDF) + JSON, hash-stamped |
| Deletion analysis, timeline witnesses, cross-camera correlation, OEM comparison (M5/M6/M7-correlation) | **UI fixtures** (`frontend/src/lib/mock.ts`) — the screens, data shapes and interactions are built against `plan.md`'s spec so the real analysis can be wired in without changing the UI, but the numbers shown are illustrative, not computed |

---

## 3. Repository layout

```
SIH-2026-PS150/
├── plan.md                     # Full technical/research plan (modules M0–M10, novelty map, schedule)
├── pramaan_logo.jpeg           # Product logo (used as favicon + in-app logo)
├── frontend/                   # React + TypeScript SPA
│   ├── src/pages/              # One file per screen (overview, evidence, deletion, report, tool.tsx, ...)
│   ├── src/components/pramaan/ # App shell, sidebar, evidence workspace, report/log widgets
│   ├── src/components/ui/      # shadcn/Radix primitives
│   ├── src/lib/api.ts          # Typed fetch client + SSE subscriber for the backend
│   ├── src/lib/report.ts       # Report data assembly + printable HTML/JSON generation
│   ├── src/lib/mock.ts         # Fixture data for modules not yet wired to real analysis
│   └── DESIGN.md               # UI design language (theme, type, colour semantics)
├── backend/                    # Node.js API server
│   ├── src/index.ts            # Express routes: auth, cases, evidence, forensics, tasks, SSE
│   ├── src/engine.ts           # Spawns the Python engine, parses its JSON-lines protocol
│   ├── src/auth.ts, db.ts      # JWT auth, Prisma client
│   ├── prisma/schema.prisma    # User / Case / ImageFile / ForensicsData models (SQLite)
│   └── engine/                 # The Python forensic engine (see below)
│       ├── dvr_scan/           # CLI entrypoint, Hikvision adapter, forensics.py, OCR, region editor
│       ├── criminal_detection/ # Face extraction + clustering (face_recognition + DBSCAN)
│       ├── object_detection/   # RF-DETR batched video inference
│       ├── paddle-ocr/         # OCR service for burned-in timestamps
│       └── upscayl-cli/        # Bundled GAN upscaling binary
├── notebooks/                  # Model evaluation notebooks (motion thresholds, object detection)
└── checkpoints/, scratch/      # Local experiment artefacts (git-ignored)
```

---

## 4. Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 19, TypeScript, Vite, Tailwind CSS v4, shadcn/Radix UI, Phosphor icons, `react-router-dom` (hash router — Electron-ready) |
| Backend | Node.js, Express, TypeScript, Prisma ORM, SQLite, JWT auth (`jsonwebtoken` + `bcryptjs`), Server-Sent Events |
| Forensic engine | Python, OpenCV, PyAV/FFmpeg, `pytsk3` (file-system parsing), PyTorch + `rfdetr` (object detection), `face_recognition` (dlib) + scikit-learn DBSCAN (face clustering), PaddleOCR |
| Storage | SQLite (case/evidence metadata + audit trail), flat files on disk (evidence images, derived clips) |

---

## 5. How the pieces talk to each other

1. **Upload evidence** → `POST /api/cases/:id/images` streams the file to disk, hashes it
   (SHA-256) in one pass, and records an `ImageFile` + an `intake_hashes` `ForensicsData` row.
2. **Run an evidence action** (hash / identify / parse / extract) → `POST /api/images/:id/tasks/:action`
   spawns `python -m dvr_scan.forensics <action> --image <path> --work <dir>`, and the result is
   written back as another `ForensicsData` row keyed by `dataType` (e.g. `identification`,
   `parsed_bundle`, `integrity`). `GET /api/images/:id/forensics` returns everything computed for
   that image so far, as one JSON object.
3. **Run a video-analysis tool** (motion / OCR / faces / objects / upscale) → `POST /api/tasks/:kind`
   spawns the matching engine subcommand and returns a `taskId`; the frontend opens
   `GET /api/tasks/:id/stream` (SSE) and renders each JSON line as it arrives — log lines,
   progress updates, and a final `type: "*_complete"` event carrying the **exact output file
   path** the tool wrote (so the UI shows that tool's own result, not a guess from whatever else
   is in the shared output folder).
4. **Generate a report** → the frontend calls `GET /api/cases/:id`, `GET /api/cases/:id/images`
   and `GET /api/images/:id/forensics` for every image, combines that with the case's analysis
   data, computes a SHA-256 of the assembled report content, and renders a print-ready HTML
   document (the browser's own print-to-PDF is the PDF engine — no server-side PDF library) plus
   a downloadable JSON twin.

All of this is append-only from the database's point of view: nothing is silently overwritten,
and every write is attributable to the authenticated user.

---

## 6. API reference (backend)

| Method & path | Purpose |
|---|---|
| `POST /api/auth/signup`, `/api/auth/login` | Create an account / get a JWT |
| `GET/POST /api/cases`, `GET/DELETE /api/cases/:id` | Case CRUD (scoped to the authenticated user) |
| `GET/POST /api/cases/:id/images` | List / upload evidence images (hashed on upload) |
| `GET /api/images/:id/file` | Stream the raw evidence file |
| `GET/POST /api/images/:id/forensics` | Read/write the per-image forensic data store |
| `POST /api/images/:id/tasks/:action` | Run `hash \| identify \| parse \| extract` on one image |
| `POST /api/tasks/:kind` | Run `motion \| faces \| objects \| upscale` on an uploaded video/image |
| `POST /api/tasks/ocr` | Run OCR (synchronous for a single image, task-based for a video) |
| `POST /api/tasks/upscale-image` | Upscale a single image (Lanczos or Upscayl GAN) |
| `GET /api/tasks/:id/stream` | SSE stream of a running task's log/progress/result |
| `GET /api/outputs`, `/api/outputs/file` | List/serve files the engine wrote to an output directory (with on-the-fly transcode for browser preview) |
| `POST /api/uploads` | Generic file upload for tool inputs |

All routes except `/api/health` and auth require `Authorization: Bearer <token>`.

### Python engine CLI (`python -m dvr_scan ...`)

```
dvr_scan scan                        # Motion detection (DVR-Scan core)
dvr_scan forensics hash|identify|parse|extract|upscale --image X --work DIR
dvr_scan hikvision master|hikbtree|logs|extract|convert|parse-all
dvr_scan criminal-detection index|recognize <video> --output-dir DIR
dvr_scan object-detection --weights W --model {nano,small,medium,base} --video V --output O
dvr_scan ocr --image X | --video V --output O --sample-rate R --confidence C
dvr_scan upscale --image X --model M --output O
```

---

## 7. Getting started

### Prerequisites

- Node.js 20+
- Python 3.11 (a virtual environment at `backend/engine/.venv` is expected — see below)
- `ffmpeg` (a Windows binary is already vendored at `backend/engine/ffmpeg.exe`)

### 1. Backend

```bash
cd backend
npm install
npx prisma migrate deploy   # creates backend/prisma/app.db (SQLite)
npm run dev                 # http://localhost:4000
```

Set up the Python engine venv once (heavy ML deps — PyTorch, OpenCV, dlib, PaddleOCR):

```bash
cd backend/engine
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt      # Windows
# or: .venv/bin/pip install -r requirements.txt     # macOS/Linux
```

Environment variables (all optional — sensible defaults are used if unset):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | Backend HTTP port |
| `JWT_SECRET` | a dev-only fallback | **Set this in any real deployment** |
| `DATABASE_URL` | `file:./app.db` (from `schema.prisma`) | Override the SQLite location |
| `STORAGE_DIR` | `backend/` | Where `uploads/` and `outputs/` are written |
| `PYTHON_EXE` | `backend/engine/.venv/Scripts/python.exe` if present, else `python` | Override the Python interpreter used to spawn the engine |

### 2. Frontend

```bash
cd frontend
npm install
npm run dev                 # http://localhost:5173 (or next free port)
```

Set `VITE_API_URL` if the backend isn't on `http://localhost:4000`.

### 3. Use it

Open the frontend URL → sign up → create a case → add an evidence file → run the DVR-forensics
and video-analysis tools from the sidebar → generate a report from the **Report** page.

---

## 8. Notable engineering details

- **Every evidence file is hashed once on intake** (SHA-256, streamed — never loaded fully into
  memory) and every subsequent derived artefact keeps that hash as its provenance anchor.
- **Object detection is batched, not per-frame.** RF-DETR is traced once for a fixed batch size
  (`model.inference(compile=True, batch_size=4)`) instead of re-running eager inference on every
  frame — this alone cut a real test clip's processing time from ~2m26s to ~38s on CPU.
- **Each analysis tool reports the exact file it wrote** (`output_path` on its `*_complete`
  event), rather than the UI guessing "the newest file in the shared output folder" — the latter
  silently showed the wrong tool's result whenever two tools wrote to the same case directory in
  sequence.
- **The report is tamper-evident**: its own content is hashed (SHA-256, via `crypto.subtle` in
  the browser) and that hash is printed on the document itself, so a reader can tell if a copy
  was altered after export.
- **Nothing is silently skipped.** Sections of the report that depend on data not yet available
  (e.g. a missing seizure-time clock anchor) are listed as open items with a reason, not omitted.

---

## 9. Roadmap

See **[`plan.md`](plan.md)** for the full module list, novelty claims, validation protocol
against real multi-vendor disks, and the week-by-week build schedule toward the SIH Grand
Finale. In short: wire the remaining modules (M3 schema induction, M5 deletion analysis, M6
timeline normalisation, M7 triage/correlation) from UI fixtures to the real forensic engine, add
Dahua/CP Plus/Honeywell adapters alongside the existing Hikvision one, and validate everything
against real seized-and-imaged hardware rather than synthetic data.
