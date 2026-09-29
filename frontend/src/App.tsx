import { RouterProvider, createHashRouter } from "react-router-dom"
import { AppShell } from "@/components/pramaan/app-shell"
import CasesPage from "@/pages/cases"
import EvidencePage from "@/pages/evidence"
import AnalyticsPage from "@/pages/analytics"
import AuditPage from "@/pages/audit"
import DeletionPage from "@/pages/deletion"
import RecoveryPage from "@/pages/recovery"
import ReportPage from "@/pages/report"
import OverviewPage from "@/pages/overview"
import TimelinePage from "@/pages/timeline"
import AcquisitionPage from "@/pages/acquisition"
import CorrelationPage from "@/pages/correlation"
import DevicePage from "@/pages/device"
import OemPage from "@/pages/oem"
import ExplorerPage from "@/pages/explorer"
import LoginPage from "@/pages/login"
import LandingPage from "@/pages/landing"
import ParsingPage from "@/pages/parsing"
import ToolPage from "@/pages/tool"
import ViewerPage from "@/pages/viewer"

// Hash routing so the same build works from file:// inside Electron.
const router = createHashRouter([
  { path: "/", element: <LandingPage /> },
  { path: "login", element: <LoginPage /> },
  {
    element: <AppShell />,
    children: [
      { path: "cases", element: <CasesPage /> },
      { path: "cases/:caseId", element: <OverviewPage /> },
      { path: "cases/:caseId/evidence", element: <EvidencePage /> },
      { path: "cases/:caseId/timeline", element: <TimelinePage /> },
      { path: "cases/:caseId/recovery", element: <RecoveryPage /> },
      { path: "cases/:caseId/deletion", element: <DeletionPage /> },
      { path: "cases/:caseId/analytics", element: <AnalyticsPage /> },
      { path: "cases/:caseId/report", element: <ReportPage /> },
      { path: "cases/:caseId/parsing", element: <ParsingPage /> },
      { path: "cases/:caseId/explorer", element: <ExplorerPage /> },
      { path: "cases/:caseId/viewer", element: <ViewerPage /> },
      { path: "cases/:caseId/motion", element: <ToolPage key="motion" tool="motion" /> },
      { path: "cases/:caseId/ocr", element: <ToolPage key="ocr" tool="ocr" /> },
      { path: "cases/:caseId/faces", element: <ToolPage key="faces" tool="faces" /> },
      { path: "cases/:caseId/objects", element: <ToolPage key="objects" tool="objects" /> },
      { path: "cases/:caseId/upscale", element: <ToolPage key="upscale" tool="upscale" /> },
      { path: "cases/:caseId/acquisition", element: <AcquisitionPage /> },
      { path: "cases/:caseId/device", element: <DevicePage /> },
      { path: "cases/:caseId/correlation", element: <CorrelationPage /> },
      { path: "oem", element: <OemPage /> },
      { path: "audit", element: <AuditPage /> },
    ],
  },
])

export default function App() {
  return <RouterProvider router={router} />
}
