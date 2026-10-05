// ============================================================
// Sahayak: the chat transport, and the snapshot of what the examiner is
// currently looking at.
//
// Split of responsibility, following the SIH_147 assistant this is ported
// from: the *screen* goes over the wire as context (the backend cannot know
// which tab is open or what a fixture screen is showing), while the *case
// record* does not — the backend reads that from the database with its own
// read-only tools, so a tampered request cannot make the assistant describe
// a case the examiner does not own.
// ============================================================

import { caseNav } from "@/lib/nav"
import { getToken } from "@/lib/api"

const BASE = import.meta.env.VITE_API_URL ?? "http://localhost:4000"

export interface ChatMessage {
  role: "user" | "assistant"
  content: string
}

export interface ChatReply {
  reply: string
  model: string
  toolsUsed: string[]
}

export interface ScreenSnapshot {
  screen: { route: string; label: string; purpose: string }
  caseId: string | null
  case: { id: string; name: string; description: string | null; opened: string } | null
  onScreen?: { basis: string; data: Record<string, unknown> }
}

/**
 * Describe the current screen for the system prompt. `pathname` is the router
 * path (no leading hash), e.g. "/cases/3/timeline".
 */
export function buildContext(opts: {
  pathname: string
  caseId?: string
  realCase?: { id: number; name: string; description: string | null; created_at: string } | null
}): ScreenSnapshot {
  const { pathname, caseId, realCase } = opts

  // Route segment under the case, or the top-level route for /audit and /oem.
  const segment = caseId
    ? pathname.replace(new RegExp(`^/cases/${caseId}/?`), "").replace(/\/$/, "")
    : pathname.replace(/^\//, "")

  const entry = caseNav.find((n) => n.to === segment)
  const snapshot: ScreenSnapshot = {
    screen: {
      route: segment || (caseId ? "overview" : pathname),
      label: entry?.label ?? (segment === "" ? "Overview" : segment || "Cases"),
      purpose: entry?.desc ?? "",
    },
    caseId: caseId ?? null,
    case: realCase
      ? {
          id: String(realCase.id),
          name: realCase.name,
          description: realCase.description,
          opened: realCase.created_at,
        }
      : null,
  }

  return snapshot
}

export async function sendChatMessage(messages: ChatMessage[], context: ScreenSnapshot): Promise<ChatReply> {
  const token = getToken()
  // The backend may wait out a short rate limit before answering, so allow it
  // time; but never leave the panel on "Looking..." indefinitely.
  let res: Response
  try {
    res = await fetch(`${BASE}/api/chat/query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ messages, context }),
      signal: AbortSignal.timeout(75_000),
    })
  } catch (err) {
    const timedOut = err instanceof DOMException && err.name === "TimeoutError"
    throw new Error(
      timedOut
        ? "That took too long. Try again, or ask something shorter."
        : "Can't reach the Pramaan backend. Check that it is running, then try again.",
    )
  }
  if (res.status === 401) throw new Error("Your session has expired. Log in again to use the assistant.")
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data?.success === false) {
    throw new Error(data?.error || `The assistant is unavailable (${res.status}).`)
  }
  return { reply: data.reply as string, model: data.model as string, toolsUsed: (data.toolsUsed ?? []) as string[] }
}
