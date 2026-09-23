import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './' — приложение можно выложить в любой подкаталог (например, GitHub Pages)
export default defineConfig({
  base: './',
  plugins: [react()],
});
