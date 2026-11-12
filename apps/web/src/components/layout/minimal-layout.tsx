import { Outlet } from 'react-router-dom';
import { Link2, LogOut, Sun, Moon, Monitor, ChevronsUpDown, ShieldCheck } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { ADMIN_APP_URL } from '@/lib/admin-app';
import { useTheme, accentOptions } from '@/hooks/use-theme';
import { Toaster } from '@/components/ui/toast';
import { EmailVerificationBanner } from '@/components/email-verification-banner';
import { FactorResetPendingBanner } from '@/components/factor-reset-banner';
import { StaffLinkBanner } from '@/components/staff-link-banner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';

export function MinimalLayout() {
  const { user, logout } = useAuth();
  const { theme, setTheme, accent, setAccent } = useTheme();

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="container mx-auto flex h-14 items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Link2 className="size-4" />
            </div>
            <span className="font-medium">Chumbaq</span>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="flex items-center gap-2">
                <div className="flex aspect-square size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground text-xs font-medium">
                  {user?.name?.charAt(0).toUpperCase() || 'U'}
                </div>
                <span className="text-sm hidden sm:inline">{user?.name || 'User'}</span>
                <ChevronsUpDown className="size-4 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel className="font-normal">
                <div className="flex flex-col space-y-1">
                  <p className="text-sm font-medium">{user?.name}</p>
                  <p className="text-xs text-muted-foreground">{user?.email}</p>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem onClick={() => setTheme('light')}>
                  <Sun className="text-muted-foreground" />
                  Light
                  {theme === 'light' && <span className="ml-auto text-xs text-muted-foreground">Active</span>}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setTheme('dark')}>
                  <Moon className="text-muted-foreground" />
                  Dark
                  {theme === 'dark' && <span className="ml-auto text-xs text-muted-foreground">Active</span>}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setTheme('system')}>
                  <Monitor className="text-muted-foreground" />
                  System
                  {theme === 'system' && <span className="ml-auto text-xs text-muted-foreground">Active</span>}
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
                      style={{ backgroundColor: opt.color, outline: accent === opt.value ? '2px solid currentColor' : 'none', outlineOffset: '2px' }}
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
                    <ShieldCheck className="text-muted-foreground" />
                    Admin app
                  </a>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => logout()}>
                <LogOut className="text-muted-foreground" />
                Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <EmailVerificationBanner />
      <div className="container mx-auto">
        <FactorResetPendingBanner />
        <StaffLinkBanner />
      </div>
      <main>
        <Outlet />
      </main>
      <Toaster />
    </div>
  );
}
