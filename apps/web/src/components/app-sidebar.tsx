import * as React from "react"
import {
  LayoutDashboard,
  Link2,
  Users,
  Key,
  Webhook,
  Image,
  Layers,
  Settings,
  Settings2,
  Bell,
  MessageSquare,
  BarChart3,
  Contact,
  Activity,
  Target,
  GitBranch,
  Users2,
  Grid3X3,
  Play,
  GalleryHorizontal,
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

  const navItems = [
    {
      title: "Main",
      icon: LayoutDashboard,
      items: [
        { title: "Dashboard", url: base },
        { title: "Analytics", url: `${base}/analytics` },
        { title: "Attribution", url: `${base}/attribution` },
        { title: "Touchpoints", url: `${base}/touchpoints` },
        { title: "Users", url: `${base}/users` },
        { title: "Events", url: `${base}/events` },
        { title: "Links", url: `${base}/links` },
      ],
    },
    {
      title: "Widgets",
      icon: Layers,
      items: [
        { title: "Banners", url: `${base}/widgets/banners` },
        { title: "Carousels", url: `${base}/widgets/carousels` },
        { title: "Stories", url: `${base}/widgets/stories` },
        { title: "Grids", url: `${base}/widgets/grids` },
        { title: "Swipe Strips", url: `${base}/widgets/swipe-strips` },
      ],
    },
    {
      title: "Engagement",
      icon: MessageSquare,
      items: [
        { title: "In-App Messages", url: `${base}/in-app-messages` },
        { title: "Push Notifications", url: `${base}/push-notifications` },
      ],
    },
    {
      title: "Configure",
      icon: Settings2,
      items: [
        { title: "Mixpanel Cohorts", url: `${base}/mixpanel/cohorts` },
        { title: "API Keys", url: `${base}/api-keys` },
        { title: "Webhooks", url: `${base}/webhooks` },
        { title: "Members", url: `${base}/team` },
        // Owners and admins only; the API refuses members anyway.
        ...(can(project, "activity.view") ? [{ title: "Activity", url: `${base}/activity` }] : []),
      ],
    },
    {
      title: "Project Settings",
      url: `${base}/settings`,
      icon: Settings,
    },
  ]

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <ProjectSwitcher />
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={navItems} />
      </SidebarContent>
      <SidebarFooter>
        <NavUser />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
