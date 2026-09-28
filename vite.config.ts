import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// base './' => jalan di GitHub Pages dengan nama repo apa pun
export default defineConfig({ base: './', plugins: [react()] });
