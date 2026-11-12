import { useState } from "react";
import { Link } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { usePasskeyAutofill } from "@/hooks/use-passkey-autofill";
import { passkeyErrorMessage } from "@/lib/passkeys";
import type { SecondFactorMethod } from "@/lib/totp";
import { SecondFactorStep } from "@/components/second-factor-step";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";

const loginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});

type LoginFormValues = z.infer<typeof loginSchema>;

export function LoginForm({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"form">) {
  const { login, loginWithPasskey } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ handle: string; methods: SecondFactorMethod[] } | null>(null);
  const [usingPasskey, setUsingPasskey] = useState(false);

  const runPasskey = async (work: () => Promise<void>) => {
    setError(null);
    setUsingPasskey(true);
    try {
      await work();
    } catch (err: unknown) {
      setError(passkeyErrorMessage(err));
    } finally {
      setUsingPasskey(false);
    }
  };

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
  });

  // Off while anything else is happening, which re-arms it after a failure. The handlers
  // below also stop it themselves, since the effect's cleanup only runs after a render.
  const autofill = usePasskeyAutofill(
    !pending && !usingPasskey && !isSubmitting,
    (err) => setError(passkeyErrorMessage(err)),
  );

  const onSubmit = async (data: LoginFormValues) => {
    autofill.stop();
    setError(null);
    try {
      const next = await login(data.email, data.password);
      if (next) setPending(next);
    } catch (err: unknown) {
      const message =
        err && typeof err === "object" && "response" in err
          ? (err as { response?: { data?: { message?: string } } }).response
              ?.data?.message
          : undefined;
      setError(message || "Invalid email or password");
    }
  };

  if (pending) {
    return (
      <SecondFactorStep
        handle={pending.handle}
        methods={pending.methods}
        onStartAgain={() => {
          setPending(null);
          setError(null);
        }}
      />
    );
  }

  return (
    <form
      className={cn("flex flex-col gap-6", className)}
      onSubmit={handleSubmit(onSubmit)}
      {...props}
    >
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-2xl font-bold">Login to your account</h1>
        <p className="text-balance text-sm text-muted-foreground">
          Enter your email below to login to your account
        </p>
      </div>
      {error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}
      <div className="grid gap-6">
        <div className="grid gap-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            placeholder="you@example.com"
            /* "webauthn" lets the browser list passkeys here; "username" keeps password managers. */
            autoComplete="username webauthn"
            {...register("email")}
          />
          {errors.email && (
            <p className="text-sm text-destructive">{errors.email.message}</p>
          )}
        </div>
        <div className="grid gap-2">
          <div className="flex items-center">
            <Label htmlFor="password">Password</Label>
            <Link
              to="/forgot-password"
              className="ml-auto text-sm underline-offset-4 hover:underline"
            >
              Forgot password?
            </Link>
          </div>
          <PasswordInput
            id="password"
            placeholder="Enter your password"
            autoComplete="current-password"
            {...register("password")}
          />
          {errors.password && (
            <p className="text-sm text-destructive">
              {errors.password.message}
            </p>
          )}
        </div>
        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting ? "Signing in..." : "Login"}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="w-full"
          disabled={usingPasskey}
          onClick={() => {
            autofill.stop();
            void runPasskey(loginWithPasskey);
          }}
        >
          {usingPasskey ? "Waiting for your passkey..." : "Sign in with a passkey"}
        </Button>
      </div>
      <div className="text-center text-sm">
        Don&apos;t have an account?{" "}
        <Link to="/register" className="underline underline-offset-4">
          Sign up
        </Link>
      </div>
    </form>
  );
}
