import { useEffect, useState } from "react"
import { PauseIcon, PlayIcon } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"

export type Kind = "motion" | "ocr" | "faces" | "objects"
export interface Overlays {
  boxes: boolean // bounding boxes
  labels: boolean // class / text labels on the boxes
  time: boolean // event time on the label (motion)
  metrics: boolean // frame metrics strip (motion)
}

const D = 8 // seconds
const FPS = 24.6
const WALK_END = 6.54 // matches the motion log: event ends at 00:00:06.540

type Box = { x: number; y: number; w: number; h: number; text: string; color: string; place?: "above" | "below"; align?: "start" | "end" }

const stamp = (t: number) => {
  const s = 9 * 3600 + 21 * 60 + 6 + Math.floor(t)
  const p = (n: number) => String(n).padStart(2, "0")
  return `06-07-2022 ${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`
}
const mmss = (t: number) => `00:00:${t.toFixed(1).padStart(4, "0")}`

/** Sample scene: a fixed CCTV view with one person walking through. Replaced by the real output video later. */
function frame(kind: Kind, t: number, o: Overlays) {
  const walking = t <= WALK_END
  const cx = -30 + (t / WALK_END) * 700
  const swing = Math.sin(t * 9) * 6
  const boxes: Box[] = []
  const motionScore = 0.78 + 0.13 * Math.abs(Math.sin(t * 1.3))

  if (kind === "motion" && walking && t >= 0.066)
    boxes.push({ x: cx - 36, y: 158, w: 72, h: 146, color: "#ff6b5b", text: `MOTION ${motionScore.toFixed(2)}${o.time ? ` · ${mmss(t)}` : ""}` })

  if (kind === "ocr") {
    const j = 0.01 * Math.abs(Math.sin(t * 3))
    boxes.push(
      { x: 10, y: 9, w: 162, h: 22, color: "#4ade80", text: `TEXT · ${stamp(t)} · ${(0.97 - j).toFixed(2)}`, place: "below" },
      { x: 462, y: 9, w: 166, h: 22, color: "#4ade80", text: `TEXT · CAM 01 ENTRANCE · ${(0.95 - j).toFixed(2)}`, place: "below", align: "end" },
      { x: 246, y: 56, w: 188, h: 44, color: "#4ade80", text: `TEXT · STAR JEWELLERS · ${(0.88 - j).toFixed(2)}`, place: "below" },
    )
  }

  if (kind === "faces" && walking && t >= 1.6 && t <= 5.6) {
    const c = 0.67 + 0.15 * Math.sin((Math.PI * (t - 1.6)) / 4)
    boxes.push({ x: cx - 19, y: 156, w: 38, h: 38, color: "#fbbf24", text: `FACE · LEAD A · ${c.toFixed(2)}` })
  }

  if (kind === "objects") {
    boxes.push({ x: 458, y: 180, w: 164, h: 96, color: "#a78bfa", text: "car 0.88" })
    if (walking) {
      boxes.push({ x: cx - 27, y: 156, w: 54, h: 148, color: "#60a5fa", text: "person 0.94" })
      boxes.push({ x: cx - 40, y: 196, w: 24, h: 44, color: "#f59e0b", text: "backpack 0.78", place: "below" })
    }
  }

  return { walking, cx, swing, boxes, motionScore }
}

function Scene({ kind, t, o }: { kind: Kind; t: number; o: Overlays }) {
  const { walking, cx, swing, boxes, motionScore } = frame(kind, t, o)
  const f = Math.floor(t * FPS)
  return (
    <svg viewBox="0 0 640 360" className="block w-full" role="img" aria-label={`Sample frame at ${mmss(t)} with ${kind} detections`}>
      <defs>
        <linearGradient id="bg" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#1e2733" />
          <stop offset="1" stopColor="#111821" />
        </linearGradient>
      </defs>
      <rect width="640" height="360" fill="url(#bg)" />
      <rect y="250" width="640" height="110" fill="#222c39" />
      <rect x="60" y="96" width="96" height="156" fill="#2b3644" stroke="#3a4859" />
      <rect x="246" y="56" width="188" height="44" rx="4" fill="#3a2f1c" />
      <text x="340" y="84" textAnchor="middle" fontSize="19" fontWeight="700" letterSpacing="2" fill="#e8c66a">STAR JEWELLERS</text>
      {/* parked car */}
      <rect x="470" y="212" width="140" height="46" rx="10" fill="#3b4656" />
      <rect x="495" y="188" width="82" height="30" rx="9" fill="#333e4d" />
      <circle cx="505" cy="260" r="13" fill="#141a22" />
      <circle cx="575" cy="260" r="13" fill="#141a22" />
      <rect x="524" y="234" width="34" height="10" fill="#d8dde3" />

      {walking && (
        <g>
          <rect x={cx - 38} y="200" width="20" height="36" rx="5" fill="#c9772e" />
          <rect x={cx - 14} y={262 + Math.max(0, swing)} width="10" height={40 - Math.max(0, swing)} rx="4" fill="#26303c" />
          <rect x={cx + 4} y={262 + Math.max(0, -swing)} width="10" height={40 - Math.max(0, -swing)} rx="4" fill="#26303c" />
          <rect x={cx - 17} y="190" width="34" height="76" rx="13" fill="#5d7391" />
          <circle cx={cx} cy="174" r="14" fill="#d9b99b" />
          <circle cx={cx - 5} cy="172" r="1.6" fill="#2a2a2a" />
          <circle cx={cx + 5} cy="172" r="1.6" fill="#2a2a2a" />
        </g>
      )}

      {/* burned-in overlay of the source recording */}
      <text x="14" y="25" fontSize="13" fontFamily="ui-monospace, Consolas, monospace" fill="#f4f6f8" opacity=".9">{stamp(t)}</text>
      <text x="624" y="25" textAnchor="end" fontSize="13" fontFamily="ui-monospace, Consolas, monospace" fill="#f4f6f8" opacity=".9">CAM 01 ENTRANCE</text>

      {kind === "motion" && o.metrics && (
        <text x="14" y="350" fontSize="11" fontFamily="ui-monospace, Consolas, monospace" fill="#ff6b5b">
          frame {String(f).padStart(3, "0")}/197 · motion {walking && t >= 0.066 ? motionScore.toFixed(2) : "0.00"} · thr 0.15
        </text>
      )}

      {o.boxes &&
        boxes.map((b, i) => {
          const tagW = b.text.length * 6.4 + 12
          const above = (b.place ?? "above") === "above"
          const tx = b.align === "end" ? b.x + b.w - tagW : b.x
          const ty = above ? b.y - 17 : b.y + b.h + 1
          return (
            <g key={i}>
              <rect x={b.x} y={b.y} width={b.w} height={b.h} fill="none" stroke={b.color} strokeWidth="2" rx="2" />
              {o.labels && (
                <>
                  <rect x={tx} y={ty} width={tagW} height="16" rx="2" fill={b.color} />
                  <text x={tx + 6} y={ty + 11.5} fontSize="10.5" fontWeight="700" fontFamily="ui-monospace, Consolas, monospace" fill="#0b0f14">{b.text}</text>
                </>
              )}
            </g>
          )
        })}
    </svg>
  )
}

type Row = { cells: string[]; at: number }
const data: Record<Kind, { cols: string[]; rows: Row[]; events: [number, number][]; start: number; color: string }> = {
  motion: {
    cols: ["Event", "From", "To", "Length", "Peak score"],
    rows: [{ cells: ["Event 1", "00:00:00.066", "00:00:06.540", "6.47 s", "0.91"], at: 0.066 }],
    events: [[0.066, 6.54]],
    start: 2.5,
    color: "#ff6b5b",
  },
  ocr: {
    cols: ["Text read", "Region", "Frames read", "Confidence"],
    rows: [
      { cells: ["06-07-2022 09:21:06 …", "Timestamp overlay, top left", "8 of 8 seconds", "0.97"], at: 0 },
      { cells: ["CAM 01 ENTRANCE", "Camera label, top right", "8 of 8 seconds", "0.95"], at: 0 },
      { cells: ["STAR JEWELLERS", "Signboard, centre", "8 of 8 seconds", "0.88"], at: 0 },
    ],
    events: [[0, 8]],
    start: 2,
    color: "#4ade80",
  },
  faces: {
    cols: ["Face", "Found at", "Confidence", "Cluster"],
    rows: [
      { cells: ["Face 1", "00:00:02.0", "0.77", "Lead A"], at: 2 },
      { cells: ["Face 2", "00:00:03.6", "0.82", "Lead A"], at: 3.6 },
      { cells: ["Face 3", "00:00:05.2", "0.71", "Lead A"], at: 5.2 },
    ],
    events: [[1.6, 5.6]],
    start: 3.6,
    color: "#fbbf24",
  },
  objects: {
    cols: ["Object", "Tracked", "Confidence", "Footage"],
    rows: [
      { cells: ["person", "00:00:00.0 to 00:00:06.5", "0.94", "Live"], at: 2.5 },
      { cells: ["backpack", "00:00:00.0 to 00:00:06.5", "0.78", "Live"], at: 2.5 },
      { cells: ["car", "Whole clip", "0.88", "Live"], at: 7 },
    ],
    events: [[0, 6.5]],
    start: 2.5,
    color: "#60a5fa",
  },
}

export function AnnotatedOutput({ kind, overlays, file, dir, video = true }: { kind: Kind; overlays: Overlays; file: string; dir: string | null; video?: boolean }) {
  const d = data[kind]
  const [t, setT] = useState(d.start)
  const [playing, setPlaying] = useState(false)

  useEffect(() => {
    if (!playing) return
    let last = performance.now()
    let id = 0
    const step = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      setT((p) => Math.min(D, p + dt))
      id = requestAnimationFrame(step)
    }
    id = requestAnimationFrame(step)
    return () => cancelAnimationFrame(id)
  }, [playing])
  useEffect(() => {
    if (t >= D) setPlaying(false)
  }, [t])

  const seek = (at: number) => {
    setPlaying(false)
    setT(at)
  }

  return (
    <div className="space-y-6">
      {video ? (
        <div className="overflow-hidden rounded-lg border">
          <div className="bg-black">
            <Scene kind={kind} t={t} o={overlays} />
          </div>
          <div className="space-y-2 bg-card px-4 pt-3 pb-4">
            <div className="flex items-center gap-4">
              <Button
                variant="outline"
                size="icon-sm"
                aria-label={playing ? "Pause" : "Play"}
                onClick={() => {
                  if (t >= D) setT(0)
                  setPlaying((p) => !p)
                }}
              >
                {playing ? <PauseIcon weight="fill" /> : <PlayIcon weight="fill" />}
              </Button>
              <Slider className="flex-1" min={0} max={D} step={0.01} value={[t]} onValueChange={([v]) => seek(v)} aria-label="Playback position" />
              <span className="w-32 shrink-0 whitespace-nowrap text-right font-mono text-caption tnum">
                {mmss(t)} / {mmss(D)}
              </span>
            </div>
            <div className="relative ml-[3.25rem] mr-[8.5rem] h-1.5 rounded-full bg-muted" aria-hidden>
              {d.events.map(([a, b], i) => (
                <span key={i} className="absolute inset-y-0 rounded-full" style={{ left: `${(a / D) * 100}%`, width: `${((b - a) / D) * 100}%`, background: d.color }} />
              ))}
            </div>
            <p className="ml-[3.25rem] text-caption text-muted-foreground">Coloured bar: where the tool found something.</p>
          </div>
        </div>
      ) : (
        <p className="rounded-md bg-muted px-4 py-3 text-body text-muted-foreground">Scan only: no video was written. The events below are still recorded.</p>
      )}

      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {d.cols.map((c, i) => (
                <TableHead key={c} className={cn(i === 0 && "pl-5")}>{c}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {d.rows.map((r) => (
              <TableRow
                key={r.cells.join()}
                tabIndex={video ? 0 : undefined}
                onClick={() => video && seek(r.at)}
                onKeyDown={(e) => video && e.key === "Enter" && seek(r.at)}
                className={cn(video && "cursor-pointer outline-none focus-visible:bg-primary-soft")}
              >
                {r.cells.map((c, i) => (
                  <TableCell key={i} className={cn(i === 0 && "pl-5 font-medium", "tnum")}>{c}</TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <p className="text-caption text-muted-foreground">
        {video ? "Click a row to jump to it. " : ""}Preview shows a sample scene. The processed video is saved as{" "}
        <span className="font-mono">{dir ? `${dir}\\${file}` : file}</span>.
      </p>
    </div>
  )
}

