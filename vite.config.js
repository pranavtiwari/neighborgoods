import { defineConfig } from 'vite';
import { resolve } from 'path';
import { readdirSync } from 'fs';

// Get all HTML files in site/public to use as entry points
const root = resolve(__dirname, 'site/public');
const htmlFiles = readdirSync(root).filter(file => file.endsWith('.html'));

const input = {};
htmlFiles.forEach(file => {
  const name = file.replace(/\.html$/, '');
  input[name] = resolve(root, file);
});

export default defineConfig({
  root: 'site/public',
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: input
    }
  },
  server: {
    port: 3000,
    open: true
  }
});
