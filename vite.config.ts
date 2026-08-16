import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The renderer is the *trusted chrome only* (tabs, address bar, Library,
// Settings). Actual website content is never rendered inside this bundle;
// it lives in separate WebContentsView instances managed by the main
// process. This keeps remote page content out of the same JS realm as our
// UI code entirely, rather than relying on iframe sandboxing.
export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
