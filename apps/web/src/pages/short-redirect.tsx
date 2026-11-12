import { useEffect } from 'react';
import { useParams } from 'react-router-dom';

export default function ShortRedirectPage() {
  const { shortCode } = useParams<{ shortCode: string }>();

  useEffect(() => {
    if (shortCode) {
      window.location.href = `/redirect/${shortCode}`;
    }
  }, [shortCode]);

  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
    </div>
  );
}
