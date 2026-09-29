// Thin fetch wrapper around the Pramaan backend (Express + Prisma), see backend/src/index.ts.
const BASE = import.meta.env.VITE_API_URL || "http://localhost:4000"
const TOKEN_KEY = "pramaan.token"
const USER_KEY = "pramaan.user"

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}
export function setSession(token: string, user: unknown) {
  localStorage.setItem(TOKEN_KEY, token)
  localStorage.setItem(USER_KEY, JSON.stringify(user))
}
export function clearSession() {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
}
export function getUser<T = { id: number; username: string; email: string }>(): T | null {
  const raw = localStorage.getItem(USER_KEY)
  return raw ? (JSON.parse(raw) as T) : null
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken()
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data?.success === false) throw new Error(data?.error || `Request failed: ${res.status}`)
  return data
}

export interface ApiUser { id: number; username: string; email: string }
export interface ApiCase { id: number; name: string; description: string | null; created_at: string; userId: number }
export interface ApiImageFile { id: number; filename: string; path_on_disk: string; hash_sha256: string | null; size_bytes: number | null; created_at: string; caseId: number }

export const api = {
  signup: (username: string, email: string, password: string) =>
    req<{ success: true; user: ApiUser; token: string }>("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ username, email, password }),
    }),
  login: (username: string, password: string) =>
    req<{ success: true; user: ApiUser; token: string }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),

  listCases: () => req<{ success: true; data: ApiCase[] }>("/api/cases"),
  createCase: (name: string, description?: string) =>
    req<{ success: true; data: ApiCase }>("/api/cases", { method: "POST", body: JSON.stringify({ name, description }) }),
  getCase: (id: number | string) => req<{ success: true; data: ApiCase }>(`/api/cases/${id}`),
  deleteCase: (id: number | string) => req<{ success: true }>(`/api/cases/${id}`, { method: "DELETE" }),

  listImages: (caseId: number | string) => req<{ success: true; data: ApiImageFile[] }>(`/api/cases/${caseId}/images`),
  addImage: (caseId: number | string, file: File) => {
    const form = new FormData()
    form.append("file", file)
    return req<{ success: true; data: ApiImageFile }>(`/api/cases/${caseId}/images`, { method: "POST", body: form })
  },
  imageFileUrl: (imageId: number | string) => `${BASE}/api/images/${imageId}/file`,

  saveForensics: (imageId: number | string, dataType: string, data: unknown) =>
    req<{ success: true }>(`/api/images/${imageId}/forensics`, { method: "POST", body: JSON.stringify({ dataType, data }) }),
  getForensics: (imageId: number | string) => req<{ success: true; data: Record<string, unknown> }>(`/api/images/${imageId}/forensics`),
  evidenceTask: (imageId: string, action: "hash" | "identify" | "parse" | "extract", recordingId?: string) =>
    req<{ success: true; taskId: string }>(`/api/images/${imageId}/tasks/${action}`, { method: "POST", body: JSON.stringify({ recordingId }) }),
  upscaleImage: (settings: Record<string, unknown>) => req<{ success: true; taskId: string }>("/api/tasks/upscale-image", { method: "POST", body: JSON.stringify(settings) }),

  upload: (file: File) => {
    const form = new FormData()
    form.append("file", file)
    return req<{ success: true; path: string; filename: string }>("/api/uploads", { method: "POST", body: form })
  },
  startTask: (kind: "motion" | "ocr" | "faces" | "objects" | "upscale", settings: Record<string, unknown>) =>
    req<{ success: true; taskId: string }>(`/api/tasks/${kind}`, { method: "POST", body: JSON.stringify(settings) }),
  taskStreamUrl: (taskId: string) => `${BASE}/api/tasks/${taskId}/stream?token=${encodeURIComponent(getToken() ?? "")}`,
  runOcr: (image: string) => req<{ success: boolean; data?: unknown; error?: string }>("/api/tasks/ocr", { method: "POST", body: JSON.stringify({ image }) }),

  listOutputs: (dir: string) =>
    req<{ success: true; files: { name: string; path: string; mtimeMs: number; size: number }[] }>(`/api/outputs?dir=${encodeURIComponent(dir)}`),
  outputFileUrl: (path: string) => `${BASE}/api/outputs/file?path=${encodeURIComponent(path)}&token=${encodeURIComponent(getToken() ?? "")}`,
}

/** Subscribe to a task's SSE stream. Returns an unsubscribe function. */
export function subscribeTask(
  taskId: string,
  handlers: { onLog?: (s: string) => void; onUpdate?: (d: any) => void; onComplete?: (d: any) => void; onError?: (s: string) => void }
) {
  const es = new EventSource(api.taskStreamUrl(taskId))
  es.addEventListener("log", (e) => handlers.onLog?.(JSON.parse((e as MessageEvent).data)))
  es.addEventListener("update", (e) => handlers.onUpdate?.(JSON.parse((e as MessageEvent).data)))
  es.addEventListener("complete", (e) => {
    handlers.onComplete?.(JSON.parse((e as MessageEvent).data))
    es.close()
  })
  es.addEventListener("error", (e) => {
    const msg = (e as MessageEvent).data
    if (msg) { handlers.onError?.(JSON.parse(msg)); es.close() }
  })
  return () => es.close()
}
