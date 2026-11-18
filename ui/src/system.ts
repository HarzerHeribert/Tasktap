// What differs between the systems the pages run on, said once: which system this is, how it writes a path, and what
// it calls the place its files are shown in. The keys' names and the shortcuts follow it in keys.ts.

const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
/** A Mac; anything else names its keys and writes its paths as Windows does. */
export const mac = /Mac|iPhone|iPad/.test(agent);

/** A path without the prefix Windows puts before a canonical one: `\\?\C:\…` is `C:\…` to a person, and
 *  `\\?\UNC\server\share` is `\\server\share`. */
export const plain = (path: string) => path.replace(/^\\\\\?\\UNC\\/, '\\\\').replace(/^\\\\\?\\/, '');
/** A path as it is shown: plain, and with the home folder as ~ where the system writes it so. */
export const shownPath = (path: string) => plain(path).replace(/^\/Users\/[^/]+/, '~');

/** Where the system shows a file among its neighbours. */
export const FILES = mac ? 'Finder' : 'File Explorer';
