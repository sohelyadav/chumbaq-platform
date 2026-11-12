import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface FactorCodeFormProps {
  id: string;
  kind: 'totp' | 'recovery-code';
  busy: boolean;
  submitLabel: string;
  onSubmit: (code: string) => void;
}

const COPY = {
  totp: {
    label: 'Code from your authenticator app',
    placeholder: '123456',
    inputMode: 'numeric',
    autoComplete: 'one-time-code',
  },
  'recovery-code': {
    label: 'Recovery code',
    placeholder: 'abcd-efgh-ijkl-mnop',
    inputMode: 'text',
    autoComplete: 'off',
  },
} as const;

/** Clears after each try, because a code that has been refused is no use a second time. */
export function FactorCodeForm({ id, kind, busy, submitLabel, onSubmit }: FactorCodeFormProps) {
  const [code, setCode] = useState('');
  const copy = COPY[kind];

  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(code.trim());
        setCode('');
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor={id}>{copy.label}</Label>
        <Input
          id={id}
          autoFocus
          maxLength={32}
          placeholder={copy.placeholder}
          inputMode={copy.inputMode}
          autoComplete={copy.autoComplete}
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
      </div>
      <Button type="submit" disabled={busy || !code.trim()}>
        {busy ? 'Checking...' : submitLabel}
      </Button>
    </form>
  );
}
