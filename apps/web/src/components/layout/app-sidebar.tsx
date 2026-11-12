import * as React from "react"
import {
  Workflow,
  LayoutDashboard,
  Link2,
  Users,
  Key,
  Webhook,
  Image,
  Layers,
  Grid3X3,
  Play,
  GalleryHorizontal,
  Settings,
  Bell,
  Mail,
  MessageSquare,
  Smartphone,
  MessageCircle,
  BarChart3,
  Contact,
  Activity,
  Target,
  GitBranch,
  Users2,
  Filter,
  History,
} from "lucide-react"

import { NavMain } from "@/components/nav-main"
import { NavUser } from "@/components/nav-user"
import { ProjectSwitcher } from "@/components/team-switcher"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
} from "@/components/ui/sidebar"
import { useCurrentProject } from "@/contexts/project-context"
import { can } from "@/lib/project-role"

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { projectId, project } = useCurrentProject()
  const base = `/projects/${projectId}`

  const mainItems = [
    { title: "Dashboard", url: base, icon: LayoutDashboard, exact: true },
    { title: "Analytics", url: `${base}/analytics`, icon: BarChart3 },
    { title: "Attribution", url: `${base}/attribution`, icon: Target },
    { title: "Touchpoints", url: `${base}/touchpoints`, icon: GitBranch },
    { title: "Users", url: `${base}/users`, icon: Contact },
    { title: "Events", url: `${base}/events`, icon: Activity },
    { title: "Links", url: `${base}/links`, icon: Link2 },
  ]

  const widgetItems = [
    { title: "Banners", url: `${base}/widgets/banners`, icon: Image },
    { title: "Carousels", url: `${base}/widgets/carousels`, icon: Layers },
    { title: "Stories", url: `${base}/widgets/stories`, icon: Play },
    { title: "Grids", url: `${base}/widgets/grids`, icon: Grid3X3 },
    { title: "Swipe Strips", url: `${base}/widgets/swipe-strips`, icon: GalleryHorizontal },
  ]

  const engagementItems = [
    { title: "Audiences", url: `${base}/segments`, icon: Filter },
    { title: "In-App Messages", url: `${base}/in-app-messages`, icon: MessageSquare },
    { title: "Push Notifications", url: `${base}/push-notifications`, icon: Bell },
    { title: "Email", url: `${base}/email`, icon: Mail },
    { title: "SMS", url: `${base}/sms`, icon: Smartphone },
    { title: "WhatsApp", url: `${base}/whatsapp`, icon: MessageCircle },
    { title: "Journeys", url: `${base}/journeys`, icon: Workflow },
  ]

  const configureItems = [
    { title: "Mixpanel Cohorts", url: `${base}/mixpanel/cohorts`, icon: Users2 },
    { title: "API Keys", url: `${base}/api-keys`, icon: Key },
    { title: "Webhooks", url: `${base}/webhooks`, icon: Webhook },
    { title: "Members", url: `${base}/team`, icon: Users },
    // Owners and admins only; the API refuses members anyway.
    ...(can(project, "activity.view") ? [{ title: "Activity", url: `${base}/activity`, icon: History }] : []),
  ]

  const settingsItems = [
    { title: "Project Settings", url: `${base}/settings`, icon: Settings },
  ]

  return (
    <Sidebar collapsible="icon" variant="inset" {...props}>
      <SidebarHeader>
        <ProjectSwitcher />
      </SidebarHeader>
      <SidebarContent>
        <NavMain label="Main" items={mainItems} />
        <NavMain label="Widgets" items={widgetItems} />
        <NavMain label="Engagement" items={engagementItems} />
        <NavMain label="Configure" items={configureItems} />
        <NavMain items={settingsItems} />
      </SidebarContent>
      <SidebarFooter>
        <NavUser />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
