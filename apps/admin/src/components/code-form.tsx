import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** A 6-digit authenticator code. Clears after each try: a refused code is no use twice. */
export function CodeForm({
  id,
  busy,
  submitLabel,
  onSubmit,
}: {
  id: string;
  busy: boolean;
  submitLabel: string;
  onSubmit: (code: string) => void;
}) {
  const [code, setCode] = useState('');
  const valid = /^\d{6}$/.test(code);

  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) return;
        onSubmit(code);
        setCode('');
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor={id}>Code from your authenticator app</Label>
        <Input
          id={id}
          autoFocus
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          placeholder="123456"
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
        />
      </div>
      <Button type="submit" disabled={busy || !valid}>
        {busy ? 'Checking...' : submitLabel}
      </Button>
    </form>
  );
}
