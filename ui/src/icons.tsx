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
  sessions: 'M3 5h15v11H3z M8 20h13V9 M6 9l2 2-2 2 M10 13h4',
  grid: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  side: 'M3 5h18v14H3z M9 5v14',
  splitRight: 'M3 5h18v14H3z M12 5v14',
  splitDown: 'M3 5h18v14H3z M3 12h18',
  copy: 'M8 8h12v13H8z M16 8V3H3v13h5',
  paste: 'M8 5H4v16h16V5h-4 M8 3h8v4H8z',
  textSmaller: 'M2 18 8 5l6 13 M4 14h8 M17 12h6',
  textLarger: 'M2 18 8 5l6 13 M4 14h8 M17 12h6 M20 9v6',
  stop: 'M6 6h12v12H6z',
  settings: 'M4 7h7 M15 7h5 M4 17h3 M11 17h9 M11 4v6 M7 14v6',
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
