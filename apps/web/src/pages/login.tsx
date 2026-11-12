import { useSearchParams } from "react-router-dom";
import { LoginForm } from "@/components/login-form";
import { sessionLimitNotice } from "@/lib/session-limit";

export default function LoginPage() {
  const [searchParams] = useSearchParams();
  const suspended = searchParams.get("suspended") === "1";
  const passwordChanged = searchParams.get("passwordChanged") === "1";
  const sessionLimit = sessionLimitNotice(searchParams.get("sessionLimit"));

  return (
    <div className="grid min-h-svh lg:grid-cols-2">
      <div className="flex flex-col gap-4 p-6 md:p-10">
        <div className="flex justify-center gap-2 md:justify-start">
          <a href="/" className="flex items-center gap-2 font-medium">
            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="size-4"
              >
                <path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3" />
              </svg>
            </div>
            Chumbaq
          </a>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <div className="flex w-full max-w-xs flex-col gap-6">
            {suspended && (
              <div role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                This account has been suspended, so you have been signed out. Contact support if you think this is a mistake.
              </div>
            )}
            {passwordChanged && (
              <div role="status" className="rounded-md bg-muted p-3 text-sm">
                Your password was changed and you were signed out everywhere. Sign in with the new password.
              </div>
            )}
            {sessionLimit && (
              <div role="status" className="rounded-md bg-muted p-3 text-sm">
                {sessionLimit}
              </div>
            )}
            <LoginForm />
          </div>
        </div>
      </div>
      <div className="relative hidden bg-muted lg:block">
        <img
          src="/login-bg.png"
          alt="Chumbaq Data Connections"
          className="absolute inset-0 h-full w-full object-cover"
        />
      </div>
    </div>
  );
}
