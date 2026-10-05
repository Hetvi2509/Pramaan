import { useCallback, useEffect, useId, useRef, useState } from "react"
import {
  ArrowClockwiseIcon,
  ArrowCounterClockwiseIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CornersInIcon,
  CornersOutIcon,
  PauseIcon,
  PlayIcon,
  SpeakerHighIcon,
  SpeakerXIcon,
} from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

// View-only filters. They change how the clip is drawn in this player and never touch the file.
// Sharpen has no CSS function, so it uses an SVG convolution filter defined inside the player.
const FILTERS = [
  { id: "standard", label: "Standard", css: "none" },
  { id: "night", label: "Night Vision", css: "grayscale(1) brightness(1.6) contrast(1.35) sepia(1) hue-rotate(75deg) saturate(2.6)" },
  { id: "invert", label: "Invert", css: "invert(1)" },
  { id: "contrast", label: "High Contrast", css: "contrast(1.8) saturate(1.15)" },
  { id: "sharpen", label: "Sharpen Detail", css: "" },
] as const
type FilterId = (typeof FILTERS)[number]["id"]

const SPEEDS = [0.25, 0.5, 1, 1.5, 2]
const COMMON_RATES = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60]
const DEFAULT_FPS = 25

const pad = (n: number, w = 2) => String(n).padStart(w, "0")
function clock(seconds: number) {
  const s = Math.max(0, seconds)
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(Math.floor(s) % 60)}.${pad(Math.floor((s % 1) * 100))}`
}
// Frame index at a time. The small allowance keeps a frame's own start time (k / fps) from reading as k - 1.
const frameAt = (t: number, fps: number) => Math.floor(t * fps + 1e-3)
const snapRate = (raw: number) => COMMON_RATES.find((r) => Math.abs(r - raw) / r < 0.01) ?? Math.round(raw * 100) / 100

type FrameMeta = { mediaTime: number }
type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: FrameMeta) => void) => number
  cancelVideoFrameCallback?: (handle: number) => void
}

/**
 * A player for evidence video: five view filters, playback speed, frame and one-second stepping,
 * sound, full screen, and a seek bar with time and frame count. `fps` is used for the frame count
 * when the caller knows it; otherwise it is measured from the first frames played.
 */
export function SurveillancePlayer({ src, fps: knownFps, title, className }: { src: string; fps?: number; title?: string; className?: string }) {
  const filterId = `sharpen-${useId().replace(/[^a-zA-Z0-9]/g, "")}`
  const box = useRef<HTMLDivElement>(null)
  const video = useRef<FrameVideo>(null)
  const deltas = useRef<number[]>([])
  const lastFrame = useRef<number | null>(null)

  const [filter, setFilter] = useState<FilterId>("standard")
  const [speed, setSpeed] = useState(1)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const [full, setFull] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [measured, setMeasured] = useState<number | null>(null)
  const [failed, setFailed] = useState(false)

  const fps = knownFps ?? measured ?? DEFAULT_FPS
  const estimated = knownFps === undefined && measured === null
  const frame = frameAt(time, fps)
  const frames = Math.round(duration * fps)

  // A new clip starts from the beginning with its own frame-rate measurement.
  useEffect(() => {
    setFailed(false); setTime(0); setDuration(0); setPlaying(false); setMeasured(null)
    deltas.current = []; lastFrame.current = null
  }, [src])

  useEffect(() => { if (video.current) video.current.playbackRate = speed }, [speed, src])

  // Frame-accurate clock: one update per displayed frame, which also tells us the frame rate.
  useEffect(() => {
    const v = video.current
    if (!v?.requestVideoFrameCallback) return
    let handle = 0
    const onFrame = (_now: number, meta: FrameMeta) => {
      setTime(meta.mediaTime)
      if (knownFps === undefined && lastFrame.current !== null && meta.mediaTime > lastFrame.current) {
        deltas.current.push(meta.mediaTime - lastFrame.current)
        if (deltas.current.length === 12) setMeasured(snapRate(1 / Math.min(...deltas.current)))
      }
      lastFrame.current = meta.mediaTime
      handle = v.requestVideoFrameCallback!(onFrame)
    }
    handle = v.requestVideoFrameCallback(onFrame)
    return () => v.cancelVideoFrameCallback?.(handle)
  }, [src, knownFps])

  useEffect(() => {
    const onChange = () => setFull(document.fullscreenElement === box.current)
    document.addEventListener("fullscreenchange", onChange)
    return () => document.removeEventListener("fullscreenchange", onChange)
  }, [])

  const seek = useCallback((t: number) => {
    const v = video.current
    if (!v || !isFinite(v.duration)) return
    const next = Math.min(Math.max(t, 0), v.duration)
    v.currentTime = next
    setTime(next)
  }, [])
  const toggle = useCallback(() => {
    const v = video.current
    if (!v) return
    if (v.paused) v.play().catch(() => setFailed(true)); else v.pause()
  }, [])
  // Stepping lands in the middle of a frame, so rounding can never leave it on the previous one.
  const step = useCallback((dir: 1 | -1) => {
    const v = video.current
    if (!v) return
    v.pause()
    seek((frameAt(v.currentTime, fps) + dir + 0.5) / fps)
  }, [fps, seek])
  const skip = useCallback((seconds: number) => seek((video.current?.currentTime ?? 0) + seconds), [seek])
  const toggleMute = useCallback(() => { const v = video.current; if (v) { v.muted = !v.muted; setMuted(v.muted) } }, [])
  const toggleFull = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen(); else box.current?.requestFullscreen()
  }, [])

  function onKeyDown(e: React.KeyboardEvent) {
    if ((e.target as HTMLElement).closest("[role=slider]") || e.ctrlKey || e.metaKey || e.altKey) return
    const handled = { " ": () => toggle(), k: () => toggle(), m: toggleMute, f: toggleFull,
      ArrowLeft: () => (e.shiftKey ? skip(-1) : step(-1)), ArrowRight: () => (e.shiftKey ? skip(1) : step(1)) }[e.key]
    if (handled) { e.preventDefault(); handled() }
  }

  const css = filter === "sharpen" ? `url(#${filterId})` : FILTERS.find((f) => f.id === filter)!.css

  return (
    <div
      ref={box}
      tabIndex={0}
      onKeyDown={onKeyDown}
      aria-label={title ? `Video player: ${title}` : "Video player"}
      className={cn("flex flex-col overflow-hidden rounded-lg border bg-card outline-none focus-visible:ring-2 focus-visible:ring-primary/50", full && "h-full rounded-none border-0", className)}
    >
      <svg aria-hidden width="0" height="0" className="absolute">
        <filter id={filterId} colorInterpolationFilters="sRGB">
          <feConvolveMatrix order="3" kernelMatrix="0 -1 0 -1 5 -1 0 -1 0" preserveAlpha="true" />
        </filter>
      </svg>

      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-hairline px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="text-caption font-medium tracking-wide text-muted-foreground uppercase">Filter</span>
          <ToggleGroup type="single" value={filter} onValueChange={(v) => v && setFilter(v as FilterId)} variant="outline" size="sm" aria-label="View filter">
            {FILTERS.map((f) => <ToggleGroupItem key={f.id} value={f.id} className="px-3">{f.label}</ToggleGroupItem>)}
          </ToggleGroup>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-caption font-medium tracking-wide text-muted-foreground uppercase">Speed</span>
          <ToggleGroup type="single" value={String(speed)} onValueChange={(v) => v && setSpeed(Number(v))} variant="outline" size="sm" aria-label="Playback speed">
            {SPEEDS.map((s) => <ToggleGroupItem key={s} value={String(s)} className="px-3 tnum">{s}x</ToggleGroupItem>)}
          </ToggleGroup>
        </div>
      </div>

      <div className={cn("relative grid place-items-center bg-black", full && "min-h-0 flex-1")}>
        <video
          ref={video}
          src={src}
          playsInline
          preload="metadata"
          onClick={toggle}
          onLoadedMetadata={(e) => { setDuration(e.currentTarget.duration); e.currentTarget.playbackRate = speed }}
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onError={() => setFailed(true)}
          style={{ filter: css }}
          className={cn("w-full cursor-pointer object-contain", full ? "max-h-full" : "max-h-[70vh]")}
        />
        {failed && (
          <p role="alert" className="absolute inset-x-6 text-center text-body text-white/85">
            This clip cannot be played here. Download it to open it in another player.
          </p>
        )}
      </div>

      <div className="space-y-3 px-4 py-3">
        <Slider
          aria-label="Seek"
          min={0}
          max={duration || 1}
          step={0.01}
          value={[Math.min(time, duration || 1)]}
          disabled={!duration || failed}
          onValueChange={([t]) => seek(t)}
        />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1">
            <Tip label={playing ? "Pause (Space)" : "Play (Space)"}>
              <Button type="button" variant={playing ? "secondary" : "default"} size="icon-sm" aria-label={playing ? "Pause" : "Play"} onClick={toggle} disabled={failed}>
                {playing ? <PauseIcon weight="fill" /> : <PlayIcon weight="fill" />}
              </Button>
            </Tip>
            <Tip label="Back one second (Shift + ←)">
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Back one second" onClick={() => skip(-1)} disabled={failed}><ArrowCounterClockwiseIcon /></Button>
            </Tip>
            <Tip label="Previous frame (←)">
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Previous frame" onClick={() => step(-1)} disabled={failed}><CaretLeftIcon weight="bold" /></Button>
            </Tip>
            <Tip label="Next frame (→)">
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Next frame" onClick={() => step(1)} disabled={failed}><CaretRightIcon weight="bold" /></Button>
            </Tip>
            <Tip label="Forward one second (Shift + →)">
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Forward one second" onClick={() => skip(1)} disabled={failed}><ArrowClockwiseIcon /></Button>
            </Tip>
            <Tip label={muted ? "Unmute (M)" : "Mute (M)"}>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={muted ? "Unmute" : "Mute"} aria-pressed={muted} onClick={toggleMute}>
                {muted ? <SpeakerXIcon /> : <SpeakerHighIcon />}
              </Button>
            </Tip>
            <Tip label={full ? "Exit full screen (F)" : "Full screen (F)"}>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={full ? "Exit full screen" : "Full screen"} onClick={toggleFull}>
                {full ? <CornersInIcon /> : <CornersOutIcon />}
              </Button>
            </Tip>
          </div>

          <div className="flex items-baseline gap-4 text-caption text-muted-foreground tnum">
            <span><span className="text-foreground">{clock(time)}</span> / {clock(duration)}</span>
            <span title={estimated ? "Frame rate not stored with this clip: assumed 25 until it plays, then measured." : `${fps} frames per second`}>
              Frame <span className="text-foreground">{frame}</span> / {frames}{estimated && "~"}
            </span>
          </div>
        </div>
        <p className="text-caption text-muted-foreground">Filters change how the clip looks in this player only. The saved file is never altered.</p>
      </div>
    </div>
  )
}

function Tip({ label, children }: { label: string; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
