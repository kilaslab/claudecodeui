import { memo } from 'react';

import { cn } from '@/shared/utils';

// One mark per subagent: a shape and a colour picked from its key, so the same
// agent keeps its identity between renders and a pair of siblings rarely look alike.
const GLYPH_COLORS = [
  'text-violet-500 dark:text-violet-400',
  'text-sky-500 dark:text-sky-400',
  'text-emerald-500 dark:text-emerald-400',
  'text-amber-500 dark:text-amber-400',
  'text-rose-500 dark:text-rose-400',
  'text-teal-500 dark:text-teal-400',
];

const GLYPH_SHAPES = [
  <circle key="circle" cx="8" cy="8" r="5" />,
  <rect key="square" x="3.5" y="3.5" width="9" height="9" rx="2.5" />,
  <path key="triangle" d="M8 3 L13.5 12.5 H2.5 Z" strokeLinejoin="round" />,
  <path key="diamond" d="M8 2.5 L13.5 8 L8 13.5 L2.5 8 Z" strokeLinejoin="round" />,
  <path key="hexagon" d="M8 2.5 L12.8 5.25 V10.75 L8 13.5 L3.2 10.75 V5.25 Z" strokeLinejoin="round" />,
  <path key="pill" d="M5.5 3.5 H10.5 A2.5 2.5 0 0 1 10.5 12.5 H5.5 A2.5 2.5 0 0 1 5.5 3.5 Z" />,
];

/** A small stable number from a string, so a key always picks the same mark. */
function hashKey(key: string): number {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  }
  return hash;
}

/**
 * Rendered by chat's DockSubagentRow as the avatar of one subagent, workflow or
 * command. It is the dock's only decoration: everything around it stays plain
 * so a running agent is what the eye finds.
 */
export const SubagentGlyph = memo(({ seed, running, className }: { seed: string; running: boolean; className?: string }) => {
  const hash = hashKey(seed);

  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={cn(
        'h-4 w-4 flex-shrink-0',
        GLYPH_COLORS[hash % GLYPH_COLORS.length],
        running && 'motion-safe:animate-pulse',
        className,
      )}
      fill="currentColor"
      fillOpacity={0.16}
      stroke="currentColor"
      strokeWidth={1.4}
    >
      {GLYPH_SHAPES[Math.floor(hash / GLYPH_COLORS.length) % GLYPH_SHAPES.length]}
    </svg>
  );
});
SubagentGlyph.displayName = 'SubagentGlyph';
