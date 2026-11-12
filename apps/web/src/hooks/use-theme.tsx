import { createContext, useContext, useEffect, useState, useCallback } from 'react';

type Theme = 'light' | 'dark' | 'system';
type Accent = 'zinc' | 'blue' | 'green' | 'orange' | 'red' | 'violet';

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  accent: Accent;
  setAccent: (accent: Accent) => void;
}

const THEME_KEY = 'chumbaq_theme';
const ACCENT_KEY = 'chumbaq_accent';

const ThemeContext = createContext<ThemeContextValue | null>(null);

const accents: Record<Accent, { light: Record<string, string>; dark: Record<string, string>; label: string; color: string }> = {
  zinc: {
    label: 'Zinc',
    color: '#71717a',
    light: {
      '--primary': 'hsl(240 5.9% 10%)',
      '--primary-foreground': 'hsl(0 0% 98%)',
      '--ring': 'hsl(240 5.9% 10%)',
      '--chart-1': 'hsl(240 5.9% 10%)',
      '--chart-2': 'hsl(240 5% 26%)',
      '--chart-3': 'hsl(240 4% 46%)',
      '--chart-4': 'hsl(240 5% 65%)',
      '--chart-5': 'hsl(240 5% 82%)',
    },
    dark: {
      '--primary': 'hsl(0 0% 98%)',
      '--primary-foreground': 'hsl(240 5.9% 10%)',
      '--ring': 'hsl(240 4.9% 83.9%)',
      '--chart-1': 'hsl(0 0% 98%)',
      '--chart-2': 'hsl(240 5% 82%)',
      '--chart-3': 'hsl(240 5% 65%)',
      '--chart-4': 'hsl(240 4% 46%)',
      '--chart-5': 'hsl(240 5% 26%)',
    },
  },
  blue: {
    label: 'Blue',
    color: '#2563eb',
    light: {
      '--primary': 'hsl(221.2 83.2% 53.3%)',
      '--primary-foreground': 'hsl(210 40% 98%)',
      '--ring': 'hsl(221.2 83.2% 53.3%)',
      '--chart-1': 'hsl(221 83% 53%)',
      '--chart-2': 'hsl(212 95% 40%)',
      '--chart-3': 'hsl(199 89% 36%)',
      '--chart-4': 'hsl(230 72% 65%)',
      '--chart-5': 'hsl(243 60% 72%)',
    },
    dark: {
      '--primary': 'hsl(217.2 91.2% 59.8%)',
      '--primary-foreground': 'hsl(222.2 47.4% 11.2%)',
      '--ring': 'hsl(224.3 76.3% 48%)',
      '--chart-1': 'hsl(217 91% 60%)',
      '--chart-2': 'hsl(205 100% 50%)',
      '--chart-3': 'hsl(195 90% 45%)',
      '--chart-4': 'hsl(232 75% 70%)',
      '--chart-5': 'hsl(245 65% 78%)',
    },
  },
  green: {
    label: 'Green',
    color: '#16a34a',
    light: {
      '--primary': 'hsl(142.1 76.2% 36.3%)',
      '--primary-foreground': 'hsl(355.7 100% 97.3%)',
      '--ring': 'hsl(142.1 76.2% 36.3%)',
      '--chart-1': 'hsl(142 76% 36%)',
      '--chart-2': 'hsl(160 84% 32%)',
      '--chart-3': 'hsl(120 60% 42%)',
      '--chart-4': 'hsl(142 65% 55%)',
      '--chart-5': 'hsl(90 60% 48%)',
    },
    dark: {
      '--primary': 'hsl(142.1 70.6% 45.3%)',
      '--primary-foreground': 'hsl(144.9 80.4% 10%)',
      '--ring': 'hsl(142.4 71.8% 29.2%)',
      '--chart-1': 'hsl(142 71% 45%)',
      '--chart-2': 'hsl(160 80% 40%)',
      '--chart-3': 'hsl(120 58% 50%)',
      '--chart-4': 'hsl(142 62% 62%)',
      '--chart-5': 'hsl(90 56% 55%)',
    },
  },
  orange: {
    label: 'Orange',
    color: '#ea580c',
    light: {
      '--primary': 'hsl(24.6 95% 53.1%)',
      '--primary-foreground': 'hsl(60 9.1% 97.8%)',
      '--ring': 'hsl(24.6 95% 53.1%)',
      '--chart-1': 'hsl(25 95% 53%)',
      '--chart-2': 'hsl(14 90% 46%)',
      '--chart-3': 'hsl(40 96% 50%)',
      '--chart-4': 'hsl(25 80% 66%)',
      '--chart-5': 'hsl(10 75% 57%)',
    },
    dark: {
      '--primary': 'hsl(20.5 90.2% 48.2%)',
      '--primary-foreground': 'hsl(60 9.1% 97.8%)',
      '--ring': 'hsl(20.5 90.2% 48.2%)',
      '--chart-1': 'hsl(21 90% 48%)',
      '--chart-2': 'hsl(10 85% 44%)',
      '--chart-3': 'hsl(38 92% 52%)',
      '--chart-4': 'hsl(21 75% 62%)',
      '--chart-5': 'hsl(8 70% 54%)',
    },
  },
  red: {
    label: 'Red',
    color: '#dc2626',
    light: {
      '--primary': 'hsl(0 72.2% 50.6%)',
      '--primary-foreground': 'hsl(0 85.7% 97.3%)',
      '--ring': 'hsl(0 72.2% 50.6%)',
      '--chart-1': 'hsl(0 72% 51%)',
      '--chart-2': 'hsl(15 80% 45%)',
      '--chart-3': 'hsl(345 75% 44%)',
      '--chart-4': 'hsl(0 65% 66%)',
      '--chart-5': 'hsl(330 60% 56%)',
    },
    dark: {
      '--primary': 'hsl(0 72.2% 50.6%)',
      '--primary-foreground': 'hsl(0 85.7% 97.3%)',
      '--ring': 'hsl(0 72.2% 50.6%)',
      '--chart-1': 'hsl(0 72% 51%)',
      '--chart-2': 'hsl(15 80% 48%)',
      '--chart-3': 'hsl(345 72% 48%)',
      '--chart-4': 'hsl(0 62% 68%)',
      '--chart-5': 'hsl(330 58% 60%)',
    },
  },
  violet: {
    label: 'Violet',
    color: '#7c3aed',
    light: {
      '--primary': 'hsl(262.1 83.3% 57.8%)',
      '--primary-foreground': 'hsl(210 40% 98%)',
      '--ring': 'hsl(262.1 83.3% 57.8%)',
      '--chart-1': 'hsl(262 83% 58%)',
      '--chart-2': 'hsl(280 76% 50%)',
      '--chart-3': 'hsl(245 70% 55%)',
      '--chart-4': 'hsl(262 70% 72%)',
      '--chart-5': 'hsl(300 65% 58%)',
    },
    dark: {
      '--primary': 'hsl(263.4 70% 50.4%)',
      '--primary-foreground': 'hsl(210 40% 98%)',
      '--ring': 'hsl(263.4 70% 50.4%)',
      '--chart-1': 'hsl(263 70% 50%)',
      '--chart-2': 'hsl(280 72% 48%)',
      '--chart-3': 'hsl(245 66% 52%)',
      '--chart-4': 'hsl(263 66% 68%)',
      '--chart-5': 'hsl(300 60% 56%)',
    },
  },
};

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.remove('light', 'dark');

  if (theme === 'system') {
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.classList.add(systemDark ? 'dark' : 'light');
  } else {
    root.classList.add(theme);
  }
}

function applyAccent(accent: Accent) {
  const root = document.documentElement;
  const isDark = root.classList.contains('dark');
  const vars = isDark ? accents[accent].dark : accents[accent].light;

  for (const [key, value] of Object.entries(vars)) {
    root.style.setProperty(key, value);
  }
}

export const accentOptions = Object.entries(accents).map(([key, val]) => ({
  value: key as Accent,
  label: val.label,
  color: val.color,
}));

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    return (localStorage.getItem(THEME_KEY) as Theme) || 'light';
  });

  const [accent, setAccentState] = useState<Accent>(() => {
    return (localStorage.getItem(ACCENT_KEY) as Accent) || 'zinc';
  });

  const setTheme = useCallback((t: Theme) => {
    localStorage.setItem(THEME_KEY, t);
    setThemeState(t);
  }, []);

  const setAccent = useCallback((a: Accent) => {
    localStorage.setItem(ACCENT_KEY, a);
    setAccentState(a);
  }, []);

  useEffect(() => {
    applyTheme(theme);
    applyAccent(accent);
  }, [theme, accent]);

  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      applyTheme('system');
      applyAccent(accent);
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme, accent]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, accent, setAccent }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
