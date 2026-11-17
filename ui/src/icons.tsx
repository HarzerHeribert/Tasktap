// The prototype's icon paths (prototype/app.js), only those the pages use.
const paths = {
  check: 'm4 12 5 5L20 6',
  down: 'm6 9 6 6 6-6',
  right: 'm9 5 7 7-7 7',
  arrow: 'M4 12h15 m-6-6 6 6-6 6',
  back: 'M20 12H4m6-6-6 6 6 6',
  folder: 'M3 6h7l2 3h9v11H3z',
  x: 'm6 6 12 12 M18 6 6 18',
  plus: 'M12 5v14 M5 12h14',
  note: 'M5 3h14v18H5z M9 3v18 M12 8h4 M12 12h4',
  terminal: 'M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z M6 8l3 3-3 3 M12 14h5',
  attention: 'M12 5v9 M12 18v1',
  shield: 'M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6z',
  claude: 'M12 2v20 M2 12h20 M5 5l14 14 M5 19 19 5 M8 3l8 18 M3 16l18-8 M3 8l18 8 M8 21l8-18',
  codex: 'm8 7-5 5 5 5 M16 7l5 5-5 5 M14 4l-4 16',
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name }: { name: IconName | string }) {
  const d = paths[name as IconName] ?? paths.note;
  return (
    <svg class="icon" aria-hidden="true" viewBox="0 0 24 24">
      <path d={d} />
    </svg>
  );
}
