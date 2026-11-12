import { createContext, useContext, useState, useCallback, ReactNode } from 'react';

interface BreadcrumbOverride {
  label: string;
  badge?: { text: string; variant: 'default' | 'secondary' | 'destructive' };
}

interface BreadcrumbContextValue {
  override: BreadcrumbOverride | null;
  setOverride: (override: BreadcrumbOverride | null) => void;
}

const BreadcrumbContext = createContext<BreadcrumbContextValue | null>(null);

export function BreadcrumbProvider({ children }: { children: ReactNode }) {
  const [override, setOverrideState] = useState<BreadcrumbOverride | null>(null);
  const setOverride = useCallback((o: BreadcrumbOverride | null) => setOverrideState(o), []);

  return (
    <BreadcrumbContext.Provider value={{ override, setOverride }}>
      {children}
    </BreadcrumbContext.Provider>
  );
}

export function useBreadcrumb() {
  const context = useContext(BreadcrumbContext);
  if (!context) {
    throw new Error('useBreadcrumb must be used within BreadcrumbProvider');
  }
  return context;
}
