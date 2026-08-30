import { Component, useEffect, useState, type ReactNode } from "react";

/**
 * The pieces every screen in Ombuds is built from.
 *
 * Three of them exist because of one line in CLAUDE.md section 8: handle the
 * empty state, the loading state, and the error state on every screen, because
 * a judge will click something we did not anticipate. Having them as named
 * components rather than as ad-hoc paragraphs is what makes it possible to
 * check that every screen actually has all three.
 *
 * None of them is red. An error is not a harm finding, and this product has
 * exactly one meaning for that colour.
 */

// =============================================================================
// Provenance — the line under every figure saying where it came from
// =============================================================================

/**
 * The single most important component in the product.
 *
 * Ombuds shows two kinds of claim on the same screen: what federal inspectors
 * found, and what a facility said about itself in an email. They look similar
 * and they are not remotely the same thing, so every figure carries a line
 * saying which it is and when it was established. CLAUDE.md calls this an
 * ethical requirement, and it is the safeguard that makes publishing real
 * facilities' harm records defensible.
 */
export function Provenance({ children }: { children: ReactNode }) {
  return <p className="mt-1 text-[14px] leading-normal text-muted">{children}</p>;
}

/** A federal figure. Always carries the date it was inspected. */
export function FederalSource({ children }: { children: ReactNode }) {
  return (
    <p className="mt-1 text-[14px] leading-normal text-muted">
      <span className="font-medium">Federal record</span> · {children}
    </p>
  );
}

/** A facility's own claim. Always carries the date they told us. */
export function ReportedSource({ children }: { children: ReactNode }) {
  return (
    <p className="mt-1 text-[14px] leading-normal text-muted">
      <span className="font-medium">Reported by the facility</span> · {children}
    </p>
  );
}

// =============================================================================
// The three states
// =============================================================================

/**
 * Loading. Says what is being waited for, because "Loading…" on its own tells a
 * family nothing and reads as a hang.
 */
export function Loading({ what }: { what: string }) {
  return (
    <p className="flex items-center gap-2 text-[16px] text-muted" aria-live="polite">
      <span
        aria-hidden
        className="inline-block h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-rule-strong"
      />
      {what}
    </p>
  );
}

/**
 * Empty. A real answer rather than an absence — "we looked and there is
 * nothing" is different information from "we have not looked", and this
 * component always states which.
 */
export function Empty({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="rounded border border-rule p-6">
      <p className="text-[16px] font-medium">{title}</p>
      {children && (
        <p className="mt-1 max-w-2xl text-[16px] leading-relaxed text-muted">
          {children}
        </p>
      )}
    </div>
  );
}

/**
 * Error. Deliberately not red, deliberately not a stack trace, and it always
 * says what is still trustworthy on the rest of the page — because in this
 * product the failure of a web scrape has nothing to do with the reliability of
 * a federal inspection record shown beside it.
 */
export function ErrorState({
  title,
  detail,
  onRetry,
}: {
  title: string;
  detail?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="rounded border-l-4 border-rule-strong bg-sunk p-4" role="alert">
      <p className="text-[16px] font-medium">{title}</p>
      {detail && (
        <p className="mt-1 max-w-2xl text-[16px] leading-relaxed text-muted">
          {detail}
        </p>
      )}
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-3 rounded border border-rule-strong px-3 py-1.5 text-[16px] font-medium hover:bg-paper"
        >
          Try again
        </button>
      )}
    </div>
  );
}

// =============================================================================
// Error boundary
// =============================================================================

/**
 * The backstop.
 *
 * Without this, one thrown render error anywhere in the tree gives a judge a
 * white screen and no way back. With it they get a sentence and a working
 * button. This is the "judges will click something we did not anticipate" line
 * in CLAUDE.md taken literally.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; fallbackLabel?: string; onReset?: () => void },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("render error", error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="mx-auto max-w-3xl px-6 py-16">
        <ErrorState
          title={`Something went wrong ${this.props.fallbackLabel ?? "on this screen"}.`}
          detail="Nothing you were shown was wrong — this screen failed to draw. The federal inspection record and every reply we have received are unaffected."
          onRetry={() => {
            this.setState({ error: null });
            this.props.onReset?.();
          }}
        />
      </div>
    );
  }
}

// =============================================================================
// Theme
// =============================================================================

type Theme = "system" | "light" | "dark";
const THEME_KEY = "ombuds-theme";

function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // A private window, or site data blocked. System preference is a fine
    // answer and the page must still render.
  }
  return "system";
}

/**
 * Light and dark are both first-class (CLAUDE.md section 8), and which one a
 * reader gets is their choice rather than ours. "System" is the default and
 * stays live — a phone that flips to dark at sunset flips this page with it.
 */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(readTheme);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    try {
      if (theme === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Not being able to remember the choice is not a reason to ignore it.
    }
  }, [theme]);

  return { theme, setTheme };
}

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const options: { value: Theme; label: string }[] = [
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
    { value: "system", label: "Auto" },
  ];

  return (
    <fieldset className="flex items-center gap-1">
      <legend className="sr-only">Colour theme</legend>
      {options.map((option) => {
        const active = theme === option.value;
        return (
          <label
            key={option.value}
            className={`theme-option cursor-pointer rounded px-2 py-1 text-[14px] ${
              active
                ? "border border-rule-strong font-medium"
                : "border border-transparent text-muted hover:text-ink"
            }`}
          >
            <input
              type="radio"
              name="theme"
              value={option.value}
              checked={active}
              onChange={() => setTheme(option.value)}
              className="sr-only"
            />
            {option.label}
          </label>
        );
      })}
    </fieldset>
  );
}
