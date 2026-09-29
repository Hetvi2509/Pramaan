import { useEffect, useState, type ComponentType } from "react"
import { useMatch, useNavigate } from "react-router-dom"
import { CornersOutIcon, MinusIcon, SquareIcon, XIcon } from "@phosphor-icons/react"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Kbd } from "@/components/ui/kbd"
import {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarShortcut,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
  MenubarTrigger,
} from "@/components/ui/menubar"
import { useSidebar } from "@/components/ui/sidebar"
import { LogoMark } from "@/components/pramaan/logo"

export interface NavItem {
  g: string
  to: string
  label: string
  icon: ComponentType
}

const shortcuts = [
  ["New case", "Ctrl N"],
  ["Search or jump to…", "Ctrl K"],
  ["Toggle sidebar", "Ctrl B"],
  ["Zoom in / out / reset", "Ctrl + / − / 0"],
]

// The Electron shell can expose window controls as window.pramaan; in a browser they explain themselves.
type Host = { minimize?: () => void; close?: () => void }
const host = () => (window as unknown as { pramaan?: Host }).pramaan

export function MenuBar({ nav, onSearch }: { nav: NavItem[]; onSearch: () => void }) {
  const navigate = useNavigate()
  const { toggleSidebar } = useSidebar()
  const caseId = useMatch("/cases/:caseId/*")?.params.caseId
  const [help, setHelp] = useState<"keys" | "about" | null>(null)
  const [zoom, setZoom] = useState(1)
  const [full, setFull] = useState(false)

  useEffect(() => {
    document.documentElement.style.zoom = String(zoom)
  }, [zoom])
  useEffect(() => {
    const f = () => setFull(!!document.fullscreenElement)
    document.addEventListener("fullscreenchange", f)
    return () => document.removeEventListener("fullscreenchange", f)
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      if (e.key === "n") (e.preventDefault(), navigate("/cases?new=1"))
      else if (e.key === "=" || e.key === "+") (e.preventDefault(), setZoom((z) => Math.min(1.5, +(z + 0.1).toFixed(1))))
      else if (e.key === "-") (e.preventDefault(), setZoom((z) => Math.max(0.7, +(z - 0.1).toFixed(1))))
      else if (e.key === "0") (e.preventDefault(), setZoom(1))
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [navigate])

  const toggleFull = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen())
  const inCase = (to: string) => navigate(`/cases/${caseId}${to ? `/${to}` : ""}`)
  const control = (fn: (() => void) | undefined, what: string) =>
    fn ? fn() : toast(`${what} is available in the desktop app`)

  const ctl = "grid h-9 w-11 place-items-center text-muted-foreground transition-colors duration-150 outline-none hover:bg-muted focus-visible:bg-muted [&_svg]:size-3.5"

  return (
    <>
      <div className="fixed inset-x-0 top-0 z-50 flex h-9 items-center border-b border-hairline bg-card pl-3 select-none">
        <div className="flex items-center gap-2 pr-3">
          <LogoMark className="size-4 rounded-[5px]" />
          <span className="text-caption font-medium">Pramaan Forensics System</span>
        </div>

        <Menubar className="h-9 gap-0 rounded-none border-0 bg-transparent p-0 shadow-none">
          <MenubarMenu>
            <MenubarTrigger className="h-7 px-2.5 text-caption">File</MenubarTrigger>
            <MenubarContent>
              <MenubarItem onSelect={() => navigate("/cases?new=1")}>
                New case <MenubarShortcut>Ctrl N</MenubarShortcut>
              </MenubarItem>
              <MenubarItem onSelect={() => navigate("/cases")}>Open case…</MenubarItem>
              <MenubarSeparator />
              <MenubarItem disabled={!caseId} onSelect={() => inCase("evidence")}>Add forensic image</MenubarItem>
              <MenubarItem disabled={!caseId} onSelect={() => inCase("parsing")}>Parse image</MenubarItem>
              <MenubarItem disabled={!caseId} onSelect={() => inCase("report")}>Generate report</MenubarItem>
              <MenubarSeparator />
              <MenubarItem onSelect={() => navigate("/audit")}>Audit trail</MenubarItem>
              <MenubarItem onSelect={() => navigate("/login")}>Log out</MenubarItem>
            </MenubarContent>
          </MenubarMenu>

          <MenubarMenu>
            <MenubarTrigger className="h-7 px-2.5 text-caption">Edit</MenubarTrigger>
            <MenubarContent>
              <MenubarItem onSelect={() => document.execCommand("copy")}>
                Copy <MenubarShortcut>Ctrl C</MenubarShortcut>
              </MenubarItem>
              <MenubarItem onSelect={() => document.execCommand("selectAll")}>
                Select all <MenubarShortcut>Ctrl A</MenubarShortcut>
              </MenubarItem>
              <MenubarSeparator />
              <MenubarItem onSelect={onSearch}>
                Search or jump to… <MenubarShortcut>Ctrl K</MenubarShortcut>
              </MenubarItem>
            </MenubarContent>
          </MenubarMenu>

          <MenubarMenu>
            <MenubarTrigger className="h-7 px-2.5 text-caption">View</MenubarTrigger>
            <MenubarContent>
              <MenubarItem onSelect={toggleSidebar}>
                Toggle sidebar <MenubarShortcut>Ctrl B</MenubarShortcut>
              </MenubarItem>
              <MenubarSub>
                <MenubarSubTrigger disabled={!caseId}>Go to</MenubarSubTrigger>
                <MenubarSubContent>
                  {nav.map((n) => (
                    <MenubarItem key={n.label} onSelect={() => inCase(n.to)}>
                      {n.label}
                    </MenubarItem>
                  ))}
                </MenubarSubContent>
              </MenubarSub>
              <MenubarSeparator />
              <MenubarItem onSelect={() => setZoom((z) => Math.min(1.5, +(z + 0.1).toFixed(1)))}>
                Zoom in <MenubarShortcut>Ctrl +</MenubarShortcut>
              </MenubarItem>
              <MenubarItem onSelect={() => setZoom((z) => Math.max(0.7, +(z - 0.1).toFixed(1)))}>
                Zoom out <MenubarShortcut>Ctrl −</MenubarShortcut>
              </MenubarItem>
              <MenubarItem onSelect={() => setZoom(1)}>
                Actual size <MenubarShortcut>Ctrl 0</MenubarShortcut>
              </MenubarItem>
              <MenubarSeparator />
              <MenubarItem onSelect={toggleFull}>{full ? "Exit full screen" : "Full screen"}</MenubarItem>
            </MenubarContent>
          </MenubarMenu>

          <MenubarMenu>
            <MenubarTrigger className="h-7 px-2.5 text-caption">Window</MenubarTrigger>
            <MenubarContent>
              <MenubarItem onSelect={() => control(host()?.minimize, "Minimise")}>Minimise</MenubarItem>
              <MenubarItem onSelect={toggleFull}>{full ? "Restore" : "Maximise"}</MenubarItem>
              <MenubarSeparator />
              <MenubarItem onSelect={() => control(host()?.close, "Close")}>Close</MenubarItem>
            </MenubarContent>
          </MenubarMenu>

          <MenubarMenu>
            <MenubarTrigger className="h-7 px-2.5 text-caption">Help</MenubarTrigger>
            <MenubarContent>
              <MenubarItem onSelect={() => setHelp("keys")}>Keyboard shortcuts</MenubarItem>
              <MenubarItem onSelect={() => setHelp("about")}>About Pramaan</MenubarItem>
            </MenubarContent>
          </MenubarMenu>
        </Menubar>

        <div className="ml-auto flex">
          <button type="button" aria-label="Minimise" className={ctl} onClick={() => control(host()?.minimize, "Minimise")}>
            <MinusIcon />
          </button>
          <button type="button" aria-label={full ? "Restore" : "Maximise"} className={ctl} onClick={toggleFull}>
            {full ? <CornersOutIcon /> : <SquareIcon />}
          </button>
          <button
            type="button"
            aria-label="Close"
            className={`${ctl} hover:bg-danger hover:text-primary-foreground focus-visible:bg-danger focus-visible:text-primary-foreground`}
            onClick={() => control(host()?.close, "Close")}
          >
            <XIcon />
          </button>
        </div>
      </div>

      <Dialog open={help !== null} onOpenChange={(o) => !o && setHelp(null)}>
        <DialogContent className="sm:max-w-md">
          {help === "keys" ? (
            <>
              <DialogHeader className="space-y-2">
                <DialogTitle className="font-display text-heading font-normal">Keyboard shortcuts</DialogTitle>
                <DialogDescription>Ctrl becomes ⌘ on a Mac.</DialogDescription>
              </DialogHeader>
              <dl className="divide-y divide-hairline">
                {shortcuts.map(([a, k]) => (
                  <div key={a} className="flex items-center justify-between py-3">
                    <dt>{a}</dt>
                    <dd className="flex gap-1">
                      {k.split(" ").map((x) => (
                        <Kbd key={x}>{x}</Kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </>
          ) : (
            <DialogHeader className="space-y-3">
              <DialogTitle className="font-display text-heading font-normal">About Pramaan</DialogTitle>
              <DialogDescription>
                Vendor-agnostic forensic analysis of DVR and NVR disks. Recovers footage, explains how it went missing, and reports every timestamp with its
                uncertainty. Runs fully offline.
              </DialogDescription>
              <p className="text-caption text-muted-foreground">SIH 2026 · PS 26150 · prototype build</p>
            </DialogHeader>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
