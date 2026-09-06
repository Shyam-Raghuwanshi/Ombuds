/**
 * The Ombuds mark: two overlapping records with one finding at the centre of
 * both.
 *
 * Inlined rather than loaded from `logo.svg` through an <img>, and the reason
 * is the theme toggle. An <img> is an isolated document: it cannot see the
 * `data-theme` attribute this app sets, so it can only follow the operating
 * system's preference. A reader whose laptop is in light mode but who chose
 * Dark in the header would get a near-black mark on a near-black bar — the one
 * element on the page that ignored their choice. Inlined, it is drawn in
 * `currentColor` and takes the ink of the text beside it, whichever way the
 * theme was arrived at.
 *
 * The geometry is `logo.svg` exactly, on that file's tight viewBox. The
 * standalone file keeps its own `prefers-color-scheme` rule for the places that
 * genuinely cannot inherit — the favicon, a README, a social card.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="24 40 112 80"
      className={className}
      aria-hidden
      focusable="false"
    >
      <g fill="none" stroke="currentColor" strokeWidth="6">
        <circle cx="64" cy="80" r="34" />
        <circle cx="96" cy="80" r="34" />
      </g>
      <circle cx="80" cy="80" r="10" fill="currentColor" />
    </svg>
  );
}
