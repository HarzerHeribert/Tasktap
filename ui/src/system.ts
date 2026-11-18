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

/** Where the system lets a program use the microphone, where it is told to move less or to save power, where the
 *  app keeps its file, and what holds a service's key: in the system's own names. */
export const MICROPHONE = mac ? 'System Settings, Privacy & Security, Microphone' : 'Windows Settings, Privacy & security, Microphone';
export const CALM = mac ? 'While Reduce Motion or Low Power Mode is on in System Settings' : 'While animation effects are off in Windows Settings or the PC saves power';
export const KEPT = mac ? "in Tasktap's own folder in your Library" : "in Tasktap's own folder among your account's app data";
export const KEYS_KEPT = mac ? 'In the keychain' : 'In Credential Manager';

/** What a person calls the machine in front of them. */
export const HERE = mac ? 'this Mac' : 'this PC';
