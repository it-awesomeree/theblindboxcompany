import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/theblindboxcompany/',
  publicDir: false,
  plugins: [
    react(),
    {
      name: 'emit-github-pages-marker',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: '.nojekyll', source: '' })
      },
    },
  ],
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.{test,spec}.{ts,tsx}'],
    setupFiles: './tests/setup.ts',
    coverage: { reporter: ['text', 'json-summary'] },
  },
})
