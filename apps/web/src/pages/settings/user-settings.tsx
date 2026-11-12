import { useState } from 'react';
import { useAuth, useUpdatePassword } from '@/hooks/use-auth';
import { removeTokens } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { User, Key } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { newPassword } from '@/lib/password';
import { toast } from '@/components/ui/use-toast';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { PasskeysCard } from '@/components/passkeys-card';
import { RecoveryCodesCard } from '@/components/recovery-codes-card';
import { TwoFactorCard } from '@/components/two-factor-card';
import { DevicesCard } from '@/components/devices-card';
import { ActivityCard } from '@/components/activity-card';
import { FactorResetBanner } from '@/components/factor-reset-banner';

const passwordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: newPassword(),
  confirmPassword: z.string().min(1, 'Please confirm your new password'),
}).refine((data) => data.newPassword === data.confirmPassword, {
  message: "Passwords don't match",
  path: ["confirmPassword"],
});

type PasswordForm = z.infer<typeof passwordSchema>;

export default function UserSettingsPage() {
  const { user } = useAuth();
  const updatePassword = useUpdatePassword();
  const navigate = useNavigate();

  const form = useForm<PasswordForm>({
    resolver: zodResolver(passwordSchema),
  });

  const onSubmit = async (data: PasswordForm) => {
    try {
      await updatePassword.mutateAsync({
        currentPassword: data.currentPassword,
        newPassword: data.newPassword,
      });
      // Changing a password ends every session, including this one.
      removeTokens();
      window.location.assign('/login?passwordChanged=1');
    } catch (err: any) {
      const msg = err?.response?.data?.message || 'Failed to update password';
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    }
  };

  return (
    <div className="container max-w-4xl py-10 space-y-8">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Account Settings</h1>
          <p className="text-muted-foreground">Manage your personal profile and security preferences.</p>
        </div>
      </div>

      <FactorResetBanner />

      <div className="grid gap-8 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <User className="h-5 w-5" />
              Profile Details
            </CardTitle>
            <CardDescription>Your personal information</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input value={user?.name || ''} disabled />
            </div>
            <div className="space-y-2">
              <Label>Email</Label>
              <Input value={user?.email || ''} disabled />
            </div>
            <p className="text-sm text-muted-foreground mt-4">
              To change your email or name, please contact support.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Key className="h-5 w-5" />
              Change Password
            </CardTitle>
            <CardDescription>Update your login password here.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <div className="space-y-2">
                <Label>Current Password</Label>
                <Input type="password" {...form.register('currentPassword')} />
                {form.formState.errors.currentPassword && (
                  <p className="text-sm text-destructive">{form.formState.errors.currentPassword.message}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label>New Password</Label>
                <Input type="password" {...form.register('newPassword')} />
                {form.formState.errors.newPassword && (
                  <p className="text-sm text-destructive">{form.formState.errors.newPassword.message}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label>Confirm New Password</Label>
                <Input type="password" {...form.register('confirmPassword')} />
                {form.formState.errors.confirmPassword && (
                  <p className="text-sm text-destructive">{form.formState.errors.confirmPassword.message}</p>
                )}
              </div>
              <Button type="submit" disabled={form.formState.isSubmitting} className="w-full mt-2">
                {form.formState.isSubmitting ? 'Updating...' : 'Update Password'}
              </Button>
            </form>
          </CardContent>
        </Card>

        <TwoFactorCard />

        <PasskeysCard />

        <RecoveryCodesCard />

        <DevicesCard />

        <ActivityCard />
      </div>
    </div>
  );
}
