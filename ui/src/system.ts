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

/** Whether the page's top row is the window's title bar, with the caption buttons the page draws in it: on Windows,
 *  unless the host kept the system's own (host/src/chrome.rs). On a Mac the system's three buttons lie over it. */
export const titled = !mac && !(typeof location !== 'undefined' && new URLSearchParams(location.search).get('chrome') === 'native');

/** Where the system shows a file among its neighbours. */
export const FILES = mac ? 'Finder' : 'File Explorer';

/** What a person calls the machine in front of them. */
export const HERE = mac ? 'this Mac' : 'this PC';
