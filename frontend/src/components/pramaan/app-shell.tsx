import { useEffect, useState } from "react"
import { Link, NavLink, Outlet, useLocation, useMatch, useNavigate } from "react-router-dom"
import {
  FolderSimpleIcon,
  ListChecksIcon,
  MagnifyingGlassIcon,
  ScalesIcon,
  GearSixIcon,
  SignOutIcon,
  PlusIcon,
} from "@phosphor-icons/react"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Kbd } from "@/components/ui/kbd"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { LogoMark, Wordmark } from "@/components/pramaan/logo"
import { MenuBar } from "@/components/pramaan/menu-bar"
import { cases } from "@/lib/mock"
import { getToken, clearSession } from "@/lib/api"
import { caseNav, navGroups } from "@/lib/nav"


function useCommandKey(open: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        open()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open])
}

function AppSidebar() {
  const match = useMatch("/cases/:caseId/*")
  const caseId = match?.params.caseId
  // Keep the case sections visible on workspace pages too, pointed at the last case opened.
  const stored = (() => {
    try {
      return localStorage.getItem("pramaan.lastCase")
    } catch {
      return null
    }
  })()
  // A real (backend) case id is not in the sample list, so trust the URL before falling back.
  const current = caseId ? (cases.find((c) => c.id === caseId) ?? { id: caseId }) : (cases.find((c) => c.id === stored) ?? (stored ? { id: stored } : cases[0]))
  useEffect(() => {
    if (!caseId) return
    try {
      localStorage.setItem("pramaan.lastCase", caseId)
    } catch {
      /* storage blocked */
    }
  }, [caseId])
  const { pathname } = useLocation()

  return (
    <Sidebar>
      <SidebarHeader className="px-4 pt-4 pb-3">
        <Link to="/cases" className="flex items-center gap-2.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-primary">
          <LogoMark />
          <Wordmark />
        </Link>
      </SidebarHeader>

      <SidebarContent className="gap-4 px-2 pt-0">
        <SidebarGroup className="p-0">
          <SidebarGroupLabel className="px-2.5 text-eyebrow tracking-(--text-eyebrow--letter-spacing) uppercase">
            Workspace
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={pathname === "/cases"}>
                  <NavLink to="/cases" end>
                    <FolderSimpleIcon />
                    <span>Cases</span>
                  </NavLink>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={pathname === "/oem"}>
                  <NavLink to="/oem">
                    <ScalesIcon />
                    <span>OEM comparison</span>
                  </NavLink>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={pathname === "/audit"}>
                  <NavLink to="/audit">
                    <ListChecksIcon />
                    <span>Audit trail</span>
                  </NavLink>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {current &&
          navGroups.map((g) => (
            <SidebarGroup key={g} className="p-0">
              <SidebarGroupLabel className="flex-col items-start gap-0.5 px-2.5 py-0 h-auto">
                <span className="text-eyebrow tracking-(--text-eyebrow--letter-spacing) uppercase">{g}</span>
                {g === "Case" && <span className="font-mono text-caption text-foreground">{current.id}</span>}
              </SidebarGroupLabel>
              <SidebarGroupContent className="mt-2">
                <SidebarMenu>
                  {caseNav.filter((i) => i.g === g).map((item) => {
                    const href = `/cases/${current.id}${item.to ? `/${item.to}` : ""}`
                    return (
                      <SidebarMenuItem key={item.label}>
                        <SidebarMenuButton asChild isActive={pathname === href}>
                          <NavLink to={href} end={item.end}>
                            <item.icon />
                            <span>{item.label}</span>
                          </NavLink>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    )
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
      </SidebarContent>

    </Sidebar>
  )
}

function Topbar({ onSearch }: { onSearch: () => void }) {
  const navigate = useNavigate()
  const match = useMatch("/cases/:caseId/*")
  const tail = match?.params["*"]
  const section = caseNav.find((n) => n.to === (tail ?? "")) ?? (tail ? undefined : caseNav[0])

  return (
    <header className="sticky top-9 z-20 flex h-14 items-center gap-3 border-b border-hairline bg-background/90 px-5 backdrop-blur-sm">
      <SidebarTrigger className="-ml-1 text-muted-foreground" />
      <Breadcrumb>
        <BreadcrumbList className="text-body">
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link to="/cases">Cases</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          {match && (
            <>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                {section?.to ? (
                  <BreadcrumbLink asChild>
                    <Link to={`/cases/${match.params.caseId}`} className="font-mono text-caption">{match.params.caseId}</Link>
                  </BreadcrumbLink>
                ) : (
                  <BreadcrumbPage className="font-mono text-caption">{match.params.caseId}</BreadcrumbPage>
                )}
              </BreadcrumbItem>
              {section?.to && (
                <>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbPage>{section.label}</BreadcrumbPage>
                  </BreadcrumbItem>
                </>
              )}
            </>
          )}
        </BreadcrumbList>
      </Breadcrumb>

      <div className="ml-auto flex items-center gap-3">
        <Button
          variant="outline"
          onClick={onSearch}
          className="h-9 w-64 justify-start gap-2.5 px-3 font-normal text-muted-foreground"
        >
          <MagnifyingGlassIcon />
          <span>Search or jump to…</span>
          <span className="ml-auto flex gap-1">
            <Kbd>Ctrl</Kbd>
            <Kbd>K</Kbd>
          </span>
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Account menu" className="rounded-full">
              <Avatar className="size-8">
                <AvatarFallback className="bg-primary-soft text-caption font-medium text-primary-soft-foreground">RD</AvatarFallback>
              </Avatar>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuLabel className="space-y-0.5 py-2">
              <p className="text-body font-medium text-foreground">R. Deshmukh</p>
              <p className="text-caption font-normal text-muted-foreground">Inspector, Cyber Forensics Lab</p>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem>
              <GearSixIcon /> Lab settings
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                clearSession()
                navigate("/login")
              }}
            >
              <SignOutIcon /> Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}

export function AppShell() {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  useCommandKey(() => setOpen(true))

  useEffect(() => {
    if (!getToken()) navigate("/login", { replace: true })
  }, [navigate])

  const go = (to: string) => {
    setOpen(false)
    navigate(to)
  }

  return (
    <TooltipProvider delayDuration={200}>
      <SidebarProvider className="pt-9">
        <MenuBar nav={caseNav} onSearch={() => setOpen(true)} />
        <AppSidebar />
        <SidebarInset className="min-w-0 bg-background">
          <Topbar onSearch={() => setOpen(true)} />
          <main className="mx-auto w-full max-w-[1200px] px-10 pt-12 pb-24">
            <Outlet />
          </main>
        </SidebarInset>
      </SidebarProvider>

      <CommandDialog open={open} onOpenChange={setOpen} title="Search" description="Jump to a case, or run an action">
        <CommandInput placeholder="Search cases, evidence, actions…" />
        <CommandList>
          <CommandEmpty>Nothing matches. Try a case number or FIR.</CommandEmpty>
          <CommandGroup heading="Recent cases">
            {cases.slice(0, 3).map((c) => (
              <CommandItem key={c.id} value={`${c.id} ${c.title} ${c.fir}`} onSelect={() => go(`/cases/${c.id}`)}>
                <FolderSimpleIcon />
                <span className="truncate">{c.title}</span>
                <CommandShortcut className="font-mono">{c.id.slice(-4)}</CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup heading="Actions">
            <CommandItem onSelect={() => go("/cases?new=1")}>
              <PlusIcon /> New case
            </CommandItem>
            <CommandItem onSelect={() => go("/audit")}>
              <ListChecksIcon /> Open audit trail
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>
      <Toaster position="bottom-right" />
    </TooltipProvider>
  )
}
