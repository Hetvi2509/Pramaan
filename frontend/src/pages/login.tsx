import { useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import { toast } from "sonner"
import {
  ArrowLeftIcon,
  EraserIcon,
  FilmStripIcon,
  FingerprintIcon,
  UsbIcon,
} from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Toaster } from "@/components/ui/sonner"
import { LogoMark, Wordmark } from "@/components/pramaan/logo"
import { HeroVisual } from "@/components/pramaan/hero-visual"
import { api, setSession } from "@/lib/api"

const highlights = [
  { icon: UsbIcon, text: "Disk images hashed on intake and re-checked before use" },
  { icon: FilmStripIcon, text: "Recovery with a quality gate, not just carved files" },
  { icon: EraserIcon, text: "Deletion explained, with a timeline of what happened" },
  { icon: FingerprintIcon, text: "Chain of custody logged for every action" },
]

export default function LoginPage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [busy, setBusy] = useState(false)
  const [lu, setLu] = useState("")
  const [lp, setLp] = useState("")
  const [su, setSu] = useState("")
  const [se, setSe] = useState("")
  const [sp, setSp] = useState("")
  const [sc, setSc] = useState("")

  async function login(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const res = await api.login(lu, lp)
      setSession(res.token, res.user)
      toast.success("Welcome back")
      navigate("/cases")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Login failed")
    } finally {
      setBusy(false)
    }
  }

  async function signup(e: React.FormEvent) {
    e.preventDefault()
    if (sp !== sc) return toast.error("Passwords do not match")
    setBusy(true)
    try {
      const res = await api.signup(su, se, sp)
      setSession(res.token, res.user)
      toast.success("Account created")
      navigate("/cases")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Signup failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid min-h-svh grid-cols-1 lg:grid-cols-2">
      <div className="relative hidden flex-col justify-between gap-8 overflow-hidden bg-primary px-12 py-10 text-primary-foreground lg:flex">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-[0.07]"
          style={{
            backgroundImage: "radial-gradient(circle, currentColor 1px, transparent 1px)",
            backgroundSize: "20px 20px",
          }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-24 -top-24 size-72 rounded-full bg-primary-foreground/10 blur-3xl"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-32 -left-16 size-80 rounded-full bg-secondary/20 blur-3xl"
        />

        <Link to="/" className="relative z-10 flex items-center gap-2.5 outline-none animate-in fade-in slide-in-from-top-2 duration-700 ease-(--ease-out)">
          <LogoMark className="bg-primary-foreground p-1" />
          <Wordmark />
        </Link>

        <div className="relative z-10 flex flex-1 min-h-0 items-center justify-center animate-in fade-in zoom-in-95 duration-1000 [animation-delay:150ms] fill-mode-backwards ease-(--ease-out)">
          <HeroVisual inverted className="size-64 sm:size-72" />
        </div>

        <div className="relative z-10 flex flex-col gap-8">
          <h2 className="max-w-sm font-display text-title text-balance animate-in fade-in slide-in-from-bottom-4 duration-700 [animation-delay:250ms] fill-mode-backwards ease-(--ease-out)">
            Every step, verified and logged, from disk to report.
          </h2>
          <ul className="flex flex-col gap-4">
            {highlights.map((h, i) => (
              <li
                key={h.text}
                className="flex items-start gap-3 animate-in fade-in slide-in-from-bottom-2 duration-700 fill-mode-backwards ease-(--ease-out)"
                style={{ animationDelay: `${320 + i * 90}ms` }}
              >
                <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-primary-foreground/15">
                  <h.icon className="size-4" />
                </div>
                <span className="text-body text-primary-foreground/90">{h.text}</span>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative z-10 text-caption text-primary-foreground/70">Runs fully offline. No data leaves this workstation.</p>
      </div>

      <div className="flex flex-col items-center justify-center gap-10 px-4 py-16">
        <Link to="/" className="flex items-center gap-2 text-caption text-muted-foreground hover:text-foreground lg:hidden">
          <ArrowLeftIcon /> Back
        </Link>

        <div className="flex flex-col items-center gap-4 text-center lg:hidden">
          <LogoMark className="size-12" />
          <Wordmark className="text-[2rem]" />
          <p className="max-w-xs text-muted-foreground">Forensic analysis of DVR and NVR disks. Runs fully offline.</p>
        </div>

        <Tabs
          defaultValue={params.get("tab") === "signup" ? "signup" : "login"}
          className="w-full max-w-sm animate-in fade-in slide-in-from-bottom-4 duration-700 ease-(--ease-out)"
        >

          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="login">Log in</TabsTrigger>
            <TabsTrigger value="signup">Sign up</TabsTrigger>
          </TabsList>
          <div className="mt-2 rounded-lg border bg-card p-8">
            <TabsContent value="login">
              <FieldGroup className="mb-6 gap-1">
                <h3 className="font-display text-heading">Welcome back</h3>
                <p className="text-caption text-muted-foreground">Sign in to continue to your cases.</p>
              </FieldGroup>
              <form onSubmit={login}>
                <FieldGroup className="gap-5">
                  <Field>
                    <FieldLabel htmlFor="lu">Username</FieldLabel>
                    <Input id="lu" required value={lu} onChange={(e) => setLu(e.target.value)} autoComplete="username" />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="lp">Password</FieldLabel>
                    <Input id="lp" type="password" required value={lp} onChange={(e) => setLp(e.target.value)} autoComplete="current-password" />
                  </Field>
                  <Button type="submit" className="w-full" disabled={busy}>Log in</Button>
                </FieldGroup>
              </form>
            </TabsContent>
            <TabsContent value="signup">
              <FieldGroup className="mb-6 gap-1">
                <h3 className="font-display text-heading">Create an account</h3>
                <p className="text-caption text-muted-foreground">Set up access for this workstation.</p>
              </FieldGroup>
              <form onSubmit={signup}>
                <FieldGroup className="gap-5">
                  <Field>
                    <FieldLabel htmlFor="su">Username</FieldLabel>
                    <Input id="su" required value={su} onChange={(e) => setSu(e.target.value)} autoComplete="username" />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="se">Email</FieldLabel>
                    <Input id="se" type="email" required value={se} onChange={(e) => setSe(e.target.value)} autoComplete="email" />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="sp">Password</FieldLabel>
                    <Input id="sp" type="password" required minLength={6} value={sp} onChange={(e) => setSp(e.target.value)} autoComplete="new-password" />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="sc">Confirm password</FieldLabel>
                    <Input id="sc" type="password" required value={sc} onChange={(e) => setSc(e.target.value)} autoComplete="new-password" />
                  </Field>
                  <Button type="submit" className="w-full" disabled={busy}>Create account</Button>
                </FieldGroup>
              </form>
            </TabsContent>
          </div>
        </Tabs>
      </div>
      <Toaster position="bottom-right" />
    </div>
  )
}
