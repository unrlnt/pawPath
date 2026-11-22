/**
 * PawPath's mascot: a golden retriever, cartoon style (CLAUDE.md §10).
 * Original artwork, drawn here as inline SVG — no stock or third-party art.
 *
 * Moods: `happy` (default; disclaimer, success), `sleepy` (loading, empty and
 * error states — "nothing here yet").
 */

import { palette } from '../styles/tokens';

export type MascotMood = 'happy' | 'sleepy';

export interface MascotProps {
  readonly mood?: MascotMood;
  readonly size?: number;
  readonly className?: string;
  /** Decorative by default; pass a label when the dog carries meaning. */
  readonly label?: string;
}

export default function Mascot({ mood = 'happy', size = 96, className, label }: MascotProps) {
  const sleepy = mood === 'sleepy';
  return (
    <svg
      viewBox="0 0 120 120"
      width={size}
      height={size}
      className={className}
      role={label === undefined ? 'presentation' : 'img'}
      aria-hidden={label === undefined}
      aria-label={label}
    >
      {/* Ears, behind the head */}
      <path d="M22 44c-10 6-14 30-6 44 5 9 15 6 17-2l4-30c1-9-8-16-15-12z" fill={palette.goldenDeep} />
      <path d="M98 44c10 6 14 30 6 44-5 9-15 6-17-2l-4-30c-1-9 8-16 15-12z" fill={palette.goldenDeep} />
      {/* Head */}
      <ellipse cx="60" cy="58" rx="36" ry="34" fill={palette.golden} />
      {/* Forehead tuft */}
      <path d="M50 26c4-6 8-6 10-1 3-5 8-4 10 2-6-1-14-1-20-1z" fill={palette.goldenDeep} />
      {/* Muzzle */}
      <ellipse cx="60" cy="76" rx="22" ry="17" fill="#F6DDB4" />
      {/* Eyes */}
      {sleepy ? (
        <>
          <path d="M38 56q6 5 12 0" stroke={palette.ink} strokeWidth="3" strokeLinecap="round" fill="none" />
          <path d="M70 56q6 5 12 0" stroke={palette.ink} strokeWidth="3" strokeLinecap="round" fill="none" />
        </>
      ) : (
        <>
          <circle cx="44" cy="55" r="5" fill={palette.ink} />
          <circle cx="76" cy="55" r="5" fill={palette.ink} />
          <circle cx="45.8" cy="53.2" r="1.6" fill="#fff" />
          <circle cx="77.8" cy="53.2" r="1.6" fill="#fff" />
        </>
      )}
      {/* Cheeks */}
      <circle cx="34" cy="68" r="5" fill={palette.terracotta} opacity="0.25" />
      <circle cx="86" cy="68" r="5" fill={palette.terracotta} opacity="0.25" />
      {/* Nose */}
      <path d="M53 68c0-4 14-4 14 0 0 4-4 7-7 7s-7-3-7-7z" fill={palette.ink} />
      {/* Mouth */}
      <path d="M60 75v4M60 79q-6 6-11 1M60 79q6 6 11 1" stroke={palette.ink} strokeWidth="2.2" strokeLinecap="round" fill="none" />
      {/* Tongue (happy) or a tiny "z" (sleepy) */}
      {sleepy ? (
        <text x="92" y="30" fontFamily="Fredoka, sans-serif" fontSize="16" fill={palette.inkSoft}>
          z
        </text>
      ) : (
        <path d="M55 82c0 8 10 8 10 0z" fill={palette.terracotta} />
      )}
    </svg>
  );
}
