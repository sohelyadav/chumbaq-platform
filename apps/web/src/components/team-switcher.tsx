import { Check, ChevronsUpDown, FolderOpen, Link2 } from "lucide-react"
import { useNavigate } from "react-router-dom"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { useCurrentProject } from "@/contexts/project-context"
import { useProjects } from "@/hooks/use-projects"
import { roleLabel } from "@/lib/project-role"

export function ProjectSwitcher() {
  const { isMobile } = useSidebar()
  const navigate = useNavigate()
  const { projectId, project } = useCurrentProject()
  const { data: projectsResponse } = useProjects()
  const projects = projectsResponse?.data ?? []

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                <FolderOpen className="size-4" />
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">{project?.name ?? "Select Project"}</span>
                <span className="truncate text-xs opacity-60">
                  {project
                    ? project.role
                      ? `${roleLabel(project.role)} · ${project.domain}`
                      : project.domain
                    : "chumbaq"}
                </span>
              </div>
              <ChevronsUpDown className="ml-auto" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-lg"
            align="start"
            side={isMobile ? "bottom" : "right"}
            sideOffset={4}
          >
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Projects
            </DropdownMenuLabel>
            {projects.map((p) => (
              <DropdownMenuItem
                key={p.id}
                onClick={() => navigate(`/projects/${p.id}`)}
                className="gap-2 p-2"
              >
                <div className="flex size-6 items-center justify-center rounded-sm border bg-background text-xs font-medium">
                  {p.name.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 truncate text-sm">{p.name}</div>
                {p.role && <span className="text-xs text-muted-foreground">{roleLabel(p.role)}</span>}
                {p.id === projectId && <Check className="size-4 text-primary" />}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => navigate("/projects")} className="gap-2 p-2">
              <div className="flex size-6 items-center justify-center rounded-md border bg-background">
                <Link2 className="size-3" />
              </div>
              <span className="text-sm font-medium text-muted-foreground">All Projects</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
