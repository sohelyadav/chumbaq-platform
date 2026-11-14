import {
  ChevronsUpDown,
  LogOut,
  Sun,
  Moon,
  Monitor,
  ShieldCheck,
  UserCog,
  CreditCard,
} from "lucide-react"
import { useNavigate } from "react-router-dom"
import { ADMIN_APP_URL } from "@/lib/admin-app"

import {
  Avatar,
  AvatarFallback,
} from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
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
import { useAuth } from "@/hooks/use-auth"
import { useBillingEnabled } from "@/hooks/use-billing"
import { getImpersonation } from "@/lib/auth"
import { BILLING_PATH, showBillingNav } from "@/lib/billing-route"
import { useTheme, accentOptions } from "@/hooks/use-theme"

export function NavUser() {
  const { isMobile } = useSidebar()
  const { user, logout } = useAuth()
  const { theme, setTheme, accent, setAccent } = useTheme()
  const navigate = useNavigate()
  const { billingEnabled } = useBillingEnabled(Boolean(user))

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <Avatar className="h-8 w-8 rounded-lg">
                <AvatarFallback className="rounded-lg bg-sidebar-primary text-sidebar-primary-foreground text-xs font-medium">
                  {user?.name?.charAt(0).toUpperCase() ?? "U"}
                </AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">{user?.name ?? "User"}</span>
                <span className="truncate text-xs">{user?.email}</span>
              </div>
              <ChevronsUpDown className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-lg"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                <Avatar className="h-8 w-8 rounded-lg">
                  <AvatarFallback className="rounded-lg bg-sidebar-primary text-sidebar-primary-foreground text-xs font-medium">
                    {user?.name?.charAt(0).toUpperCase() ?? "U"}
                  </AvatarFallback>
                </Avatar>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">{user?.name ?? "User"}</span>
                  <span className="truncate text-xs">{user?.email}</span>
                </div>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => setTheme("light")}>
                <Sun className="text-muted-foreground" />
                Light
                {theme === "light" && <span className="ml-auto text-xs text-muted-foreground">Active</span>}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setTheme("dark")}>
                <Moon className="text-muted-foreground" />
                Dark
                {theme === "dark" && <span className="ml-auto text-xs text-muted-foreground">Active</span>}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setTheme("system")}>
                <Monitor className="text-muted-foreground" />
                System
                {theme === "system" && <span className="ml-auto text-xs text-muted-foreground">Active</span>}
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <div className="px-2 py-1.5">
              <span className="text-xs font-medium text-muted-foreground">Accent</span>
              <div className="flex gap-1.5 mt-1.5">
                {accentOptions.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setAccent(opt.value)}
                    className="size-5 rounded-full ring-offset-background transition-all hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    style={{
                      backgroundColor: opt.color,
                      outline: accent === opt.value ? "2px solid currentColor" : "none",
                      outlineOffset: "2px",
                    }}
                    title={opt.label}
                  />
                ))}
              </div>
            </div>
            <DropdownMenuSeparator />
            {user?.isSuperAdmin && (
              // A separate site with its own staff sign-in, so a plain link, not a route.
              <DropdownMenuItem asChild>
                <a href={ADMIN_APP_URL} target="_blank" rel="noopener noreferrer">
                  <ShieldCheck className="text-muted-foreground mr-2 h-4 w-4" />
                  Admin app
                </a>
              </DropdownMenuItem>
            )}
            {showBillingNav(billingEnabled, Boolean(getImpersonation())) && (
              <DropdownMenuItem onClick={() => navigate(BILLING_PATH)}>
                <CreditCard className="text-muted-foreground mr-2 h-4 w-4" />
                Billing
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => navigate('/settings')}>
              <UserCog className="text-muted-foreground mr-2 h-4 w-4" />
              Account Settings
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => logout()}>
              <LogOut className="text-muted-foreground mr-2 h-4 w-4" />
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
