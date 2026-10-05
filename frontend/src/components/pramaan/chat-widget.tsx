// ============================================================
// Sahayak — the case assistant, as a floating panel on every workspace screen.
//
// Ported from the SIH_147 / qubits-dealflow assistant widget, restyled to this
// project's rules: shadcn controls only, Phosphor icons, light only, and the
// floating surface carries smooth-shadow-ring-lg with no extra border (see
// DESIGN.md "Surfaces"). Two things were added for a forensic tool: the header
// names the screen the answer is grounded in, and each answer prints the
// lookups that produced it, so a claim in the chat can be traced the same way
// a number on a screen can.
// ============================================================

import { useEffect, useMemo, useRef, useState } from "react"
import { useLocation, useMatch } from "react-router-dom"
import { ArrowClockwiseIcon, ChatsCircleIcon, PaperPlaneRightIcon, SparkleIcon, WarningCircleIcon, XIcon } from "@phosphor-icons/react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { LogoMark } from "@/components/pramaan/logo"
import { api, type ApiCase } from "@/lib/api"
import { buildContext, sendChatMessage, type ChatMessage } from "@/lib/chat"
import { cn } from "@/lib/utils"

interface Turn extends ChatMessage {
  toolsUsed?: string[]
  failed?: boolean
  /** The question to resend, on a failed answer. */
  retry?: string
}

/** Shown on an empty conversation. One of each kind the assistant handles:
 *  the case record, a term, a screen, and the limits of a finding. */
const SUGGESTIONS = [
  "Summarise this case",
  "What is HIKBTREE?",
  "What does this screen tell me?",
  "What is a Section 63 certificate?",
]

/** Tool names are internal; this is what to call them in front of an examiner. */
const TOOL_LABELS: Record<string, string> = {
  explain_term: "glossary",
  list_terms: "glossary index",
  list_cases: "your cases",
  case_detail: "case record",
  case_progress: "case progress",
  list_evidence: "evidence list",
  forensics_data: "parsed disk data",
}

function describeTools(tools: string[]): string {
  const seen = [...new Set(tools.map((t) => TOOL_LABELS[t] ?? t))]
  return seen.length ? `From ${seen.join(", ")}` : ""
}

/** Plain-text reply -> paragraphs, with "- " lines shown as a list. */
function MessageBody({ text }: { text: string }) {
  const blocks: { list: boolean; lines: string[] }[] = []
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line) continue
    const item = /^[-•]\s+(.*)$/.exec(line)
    const last = blocks[blocks.length - 1]
    if (item) {
      if (last?.list) last.lines.push(item[1])
      else blocks.push({ list: true, lines: [item[1]] })
    } else blocks.push({ list: false, lines: [line] })
  }
  return (
    <div className="space-y-2">
      {blocks.map((b, i) =>
        b.list ? (
          <ul key={i} className="space-y-1">
            {b.lines.map((l, j) => (
              <li key={j} className="flex gap-2">
                <span aria-hidden className="mt-[0.55em] size-1 shrink-0 rounded-full bg-current opacity-50" />
                <span className="min-w-0">{l}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p key={i}>{b.lines[0]}</p>
        ),
      )}
    </div>
  )
}

function ChatWidgetInner({ needsKey, onKeySaved }: { needsKey: boolean; onKeySaved: () => void }) {
  const [open, setOpen] = useState(false)
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState("")
  const [sending, setSending] = useState(false)

  const { pathname } = useLocation()
  const match = useMatch("/cases/:caseId/*")
  const caseId = match?.params.caseId
  // The case record is fetched only to label the panel and to let the
  // assistant answer "which case is this" without a round trip; the backend
  // still reads the case from the database for anything it asserts. Tagged
  // with the id it was fetched for, so a stale case is discarded during
  // render rather than cleared from an effect on every navigation.
  const [fetched, setFetched] = useState<{ caseId: string; data: ApiCase | null } | null>(null)
  const realCase = fetched && fetched.caseId === caseId ? fetched.data : null

  useEffect(() => {
    if (!caseId) return
    let live = true
    api
      .getCase(caseId)
      .then((r) => live && setFetched({ caseId, data: r.data }))
      .catch(() => live && setFetched({ caseId, data: null }))
    return () => {
      live = false
    }
  }, [caseId])

  const context = useMemo(() => buildContext({ pathname, caseId, realCase }), [pathname, caseId, realCase])

  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // A new answer scrolls to its own first line, so a long reply is read from the
  // top instead of dropping the examiner at its last paragraph. Everything else
  // (their question, the typing indicator) follows the bottom.
  useEffect(() => {
    const box = scrollRef.current
    if (!box) return
    const last = turns[turns.length - 1]
    const answer = !sending && last?.role === "assistant" ? box.querySelector<HTMLElement>("[data-latest-answer]") : null
    box.scrollTo({ top: answer ? Math.max(0, answer.offsetTop - 16) : box.scrollHeight, behavior: "smooth" })
  }, [turns, sending, open])

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open])

  async function send(text: string, isRetry = false) {
    const question = text.trim()
    if (!question || sending) return
    // A retry replaces the failed bubble instead of stacking a duplicate question.
    if (isRetry) setTurns((t) => t.slice(0, -2))
    // Failed turns are kept on screen but not sent back as history — an error
    // bubble is not something the assistant said.
    const history: ChatMessage[] = (isRetry ? turns.slice(0, -2) : turns)
      .filter((t) => !t.failed)
      .map((t) => ({ role: t.role, content: t.content }))
    const next = [...history, { role: "user" as const, content: question }]

    setTurns((t) => [...t, { role: "user", content: question }])
    setInput("")
    setSending(true)
    try {
      const { reply, toolsUsed } = await sendChatMessage(next, context)
      setTurns((t) => [
        ...t,
        // The model is told not to use markdown, but strip stray emphasis
        // markers if one slips through — this bubble renders plain text.
        { role: "assistant", content: reply.replace(/\*\*(.+?)\*\*/g, "$1"), toolsUsed },
      ])
    } catch (err) {
      setTurns((t) => [
        ...t,
        {
          role: "assistant",
          content: err instanceof Error ? err.message : "Something went wrong.",
          failed: true,
          retry: question,
        },
      ])
    } finally {
      setSending(false)
    }
  }

  const grounding = caseId
    ? `${realCase?.name ?? `Case ${caseId}`} · ${context.screen.label}`
    : context.screen.label

  return (
    <>
      <Button
        size="lg"
        onClick={() => setOpen(true)}
        aria-label="Ask Sahayak, the case assistant"
        className={cn(
          "fixed right-6 bottom-6 z-40 h-12 rounded-full pr-5 pl-4 smooth-shadow-ring-lg",
          "transition-[transform,opacity] duration-200 ease-out",
          open && "pointer-events-none scale-95 opacity-0",
        )}
      >
        <ChatsCircleIcon className="size-5" />
        Ask Sahayak
      </Button>

      <div
        role="dialog"
        aria-label="Sahayak, the case assistant"
        aria-hidden={!open}
        inert={!open}
        className={cn(
          "fixed inset-x-3 bottom-3 z-50 flex h-[min(36rem,calc(100dvh-5.5rem))] flex-col sm:inset-x-auto sm:right-6 sm:bottom-6 sm:w-[26rem]",
          "origin-bottom-right overflow-hidden rounded-xl bg-popover smooth-shadow-ring-lg",
          "transition-[transform,opacity] duration-200 ease-out",
          open ? "scale-100 opacity-100" : "pointer-events-none scale-95 opacity-0",
        )}
      >
        <header className="flex shrink-0 items-start gap-3 px-4 py-3.5">
          <LogoMark className="mt-0.5 size-7 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="font-display text-body leading-tight">Sahayak</p>
            <p className="truncate text-caption text-muted-foreground" title={grounding}>
              {grounding}
            </p>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={() => setOpen(false)} aria-label="Close assistant">
            <XIcon />
          </Button>
        </header>
        <Separator className="bg-hairline" />

        {needsKey ? (
          <div className="min-h-0 flex-1 overflow-y-auto"><KeyPrompt onSaved={onKeySaved} /></div>
        ) : (
          <>
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="flex flex-col gap-4 px-4 py-4">
            {turns.length === 0 && (
              <div className="space-y-3">
                <p className="text-caption text-muted-foreground">
                  Ask about this case — its evidence, hashes and findings — or about any term on the screen. I can only
                  look things up; nothing here changes the case.
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {SUGGESTIONS.map((s, n) => (
                    <button
                      key={s}
                      style={{ animationDelay: `${n * 45}ms` }}
                      type="button"
                      onClick={() => void send(s)}
                      className="animate-in fade-in-0 slide-in-from-bottom-1 fill-mode-both rounded-sm border border-hairline px-2.5 py-1.5 text-caption text-left duration-300 transition-[background-color,border-color,transform] hover:border-primary/40 hover:bg-primary/5 active:scale-[0.96]"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {turns.map((t, i) => (
              <div
                key={i}
                data-latest-answer={t.role === "assistant" && i === turns.length - 1 ? "" : undefined}
                className={cn(
                  "flex flex-col gap-1 animate-in fade-in-0 slide-in-from-bottom-2 duration-300 ease-[cubic-bezier(0.2,0,0,1)]",
                  t.role === "user" ? "items-end" : "items-start",
                )}
              >
                <div
                  className={cn(
                    "max-w-[86%] rounded-lg px-3 py-2 text-body break-words",
                    t.role === "user"
                      ? "bg-primary text-primary-foreground"
                      : t.failed
                        ? "bg-danger-soft text-danger"
                        : "bg-muted text-foreground",
                  )}
                >
                  {t.failed && <WarningCircleIcon className="mr-1.5 mb-0.5 inline size-4" />}
                  <MessageBody text={t.content} />
                </div>
                {t.failed && t.retry && i === turns.length - 1 ? (
                  <Button variant="outline" size="sm" disabled={sending} onClick={() => void send(t.retry!, true)}>
                    <ArrowClockwiseIcon /> Try again
                  </Button>
                ) : null}
                {t.toolsUsed?.length ? (
                  <Badge variant="outline" className="gap-1 border-hairline text-eyebrow font-normal tracking-normal">
                    <SparkleIcon className="size-3" />
                    {describeTools(t.toolsUsed)}
                  </Badge>
                ) : null}
              </div>
            ))}

            {sending && (
              <div
                role="status"
                className="flex w-fit items-center gap-1 rounded-lg bg-muted px-3.5 py-3 animate-in fade-in-0 duration-200"
              >
                <span className="sr-only">Looking…</span>
                {[0, 1, 2].map((d) => (
                  <span
                    key={d}
                    aria-hidden
                    className="size-1.5 animate-pulse rounded-full bg-muted-foreground/60"
                    style={{ animationDelay: `${d * 160}ms` }}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        <Separator className="bg-hairline" />
        <form
          className="flex shrink-0 items-end gap-2 p-3"
          onSubmit={(e) => {
            e.preventDefault()
            void send(input)
          }}
        >
          <Textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                void send(input)
              }
            }}
            rows={1}
            placeholder="Ask about the case, or a term…"
            aria-label="Your question"
            disabled={sending}
            className="max-h-28 min-h-9 resize-none py-2"
          />
          <Button type="submit" size="icon-sm" disabled={sending || !input.trim()} aria-label="Send">
            <PaperPlaneRightIcon />
          </Button>
        </form>
          </>
        )}
      </div>
    </>
  )
}

/** Asks for a Groq key once (kept in the data folder), so installed copies work without one being bundled. */
function KeyPrompt({ onSaved }: { onSaved: () => void }) {
  const [key, setKey] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  async function save() {
    setBusy(true)
    setError("")
    try {
      await api.setChatKey(key)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the key.")
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      className="space-y-3 p-4"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <p className="text-body">Sahayak needs a free Groq API key to answer.</p>
      <p className="text-caption text-muted-foreground">
        Create one at console.groq.com/keys and paste it here. It is stored only on this computer, and your questions
        and case details are sent to Groq to answer them. Everything else in Pramaan stays offline.
      </p>
      <Input value={key} onChange={(e) => setKey(e.target.value)} placeholder="gsk_..." aria-label="Groq API key" autoComplete="off" />
      {error && <p className="text-caption text-danger">{error}</p>}
      <Button type="submit" disabled={busy || !key.trim()}>{busy ? "Saving…" : "Save key"}</Button>
    </form>
  )
}

export function ChatWidget() {
  const [configured, setConfigured] = useState<boolean | null>(null)
  useEffect(() => { api.chatConfigured().then(setConfigured) }, [])
  // Wait for the answer so the panel does not flash the key form on machines that already have a key.
  return configured === null ? null : <ChatWidgetInner needsKey={!configured} onKeySaved={() => setConfigured(true)} />
}
