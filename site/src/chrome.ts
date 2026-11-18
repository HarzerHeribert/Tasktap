// The site's chrome is the app's: its motion engine and the styles it draws (ui/src/motion), bundled for the page by
// scripts/render-site.cjs into site/app/chrome.js. Nothing of it is rewritten here, so the metal, its light and its
// pace are the ones the owner froze in the app.
export { View, still, stats } from '../../ui/src/motion/engine.ts';
