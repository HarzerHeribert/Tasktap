import { defineConfig } from 'vite';

// Two pages (the notch and the workspace), built into dist/ for the host to embed. public/ holds the licences of the
// terminal's typefaces, copied as they are.
export default defineConfig({
  base: './',
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  build: {
    target: 'safari16',
    // xterm.js and its WebGL renderer are most of the workspace page; one file is fine in an app.
    chunkSizeWarningLimit: 800,
    rollupOptions: { input: { notch: 'notch.html', workspace: 'workspace.html' } },
  },
});
