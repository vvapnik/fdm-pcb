import { defineConfig } from 'vite';

// Relative base so the build works under GitHub Pages (/fdm-pcb/) and any other path.
export default defineConfig({
  base: './',
  worker: { format: 'es' },
});
