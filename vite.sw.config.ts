import { defineConfig } from 'vite';

// Сервис-воркер собирается отдельно, одним IIFE-файлом dist/sw.js,
// чтобы переиспользовать src/lib (расчёт тумана, IndexedDB) без module-воркеров.
export default defineConfig({
  publicDir: false,
  define: { __BUILD__: JSON.stringify(Date.now().toString(36)) },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: 'src/sw/sw.ts',
      formats: ['iife'],
      name: 'fogSw',
      fileName: () => 'sw.js',
    },
  },
});
