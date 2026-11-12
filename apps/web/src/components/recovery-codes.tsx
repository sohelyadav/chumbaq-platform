import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/use-toast';

export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const text = codes.join('\n');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: 'Recovery codes copied' });
    } catch {
      toast({
        title: 'Could not copy',
        description: 'Select the codes and copy them by hand.',
        variant: 'destructive',
      });
    }
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([`${text}\n`], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'chumbaq-recovery-codes.txt';
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <div role="status" className="rounded-md bg-muted p-3 text-sm">
        Save these now, somewhere other than this device. Each works once if you lose your
        other sign-in methods, and you will not see them again.
      </div>
      <ul className="grid gap-1 rounded-md border p-3 font-mono text-sm sm:grid-cols-2">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={copy}>
          Copy
        </Button>
        <Button type="button" variant="outline" onClick={download}>
          Download
        </Button>
        <Button type="button" onClick={onDone}>
          I have saved them
        </Button>
      </div>
    </div>
  );
}
