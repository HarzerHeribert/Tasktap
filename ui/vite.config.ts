import { defineConfig } from 'vite';

// Two pages (the notch and the workspace), built into dist/ for the host to embed. The prototype's stylesheets are
// imported from ../prototype as they are.
export default defineConfig({
  base: './',
  // The prototype's page background is never shown here: point it at the app's own icon, small enough to be inlined,
  // so that picture's 0.9 MB stay out of the app.
  resolve: {
    alias: [{ find: /^.*desktop\.png$/, replacement: new URL('../host/icons/icon.png', import.meta.url).pathname }],
  },
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  build: {
    target: 'safari16',
    // xterm.js and its WebGL renderer are most of the workspace page; one file is fine in an app.
    chunkSizeWarningLimit: 800,
    rollupOptions: { input: { notch: 'notch.html', workspace: 'workspace.html' } },
  },
  server: { fs: { allow: ['..'] } },
});
