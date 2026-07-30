import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { productionSecurityMetadataPlugin } from './vite-security-metadata'

export {
  PRODUCTION_CONTENT_SECURITY_POLICY,
  PRODUCTION_REFERRER_POLICY,
  productionSecurityMetadataPlugin,
  productionSecurityMetaTags,
} from './vite-security-metadata'

export default defineConfig({
  base: '/theblindboxcompany/',
  publicDir: false,
  plugins: [
    react(),
    productionSecurityMetadataPlugin(),
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
