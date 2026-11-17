import { defineConfig } from 'vite';

// Two pages, built into dist/ for the host to embed. The prototype's stylesheets and motion
// assets are imported from ../prototype as they are.
export default defineConfig({
  base: './',
  // The prototype's page background is never shown here: point it at a picture the notch already
  // carries, so its 0.9 MB stay out of the app.
  resolve: {
    alias: [{ find: /^.*desktop\.png$/, replacement: new URL('../prototype/assets/motion/glyph/miniature.jpg', import.meta.url).pathname }],
  },
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  build: {
    target: 'safari16',
    rollupOptions: { input: { notch: 'notch.html', peek: 'peek.html' } },
  },
  server: { fs: { allow: ['..'] } },
});
