import type { HtmlTagDescriptor, Plugin } from 'vite'

export const PRODUCTION_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "base-uri 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'none'",
  "connect-src 'none'",
  "object-src 'none'",
  "media-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "form-action 'none'",
].join('; ')

export const PRODUCTION_REFERRER_POLICY = 'no-referrer'

export function productionSecurityMetaTags(): HtmlTagDescriptor[] {
  return [
    {
      tag: 'meta',
      attrs: {
        'http-equiv': 'Content-Security-Policy',
        content: PRODUCTION_CONTENT_SECURITY_POLICY,
      },
      injectTo: 'head-prepend',
    },
    {
      tag: 'meta',
      attrs: {
        name: 'referrer',
        content: PRODUCTION_REFERRER_POLICY,
      },
      injectTo: 'head-prepend',
    },
  ]
}

export function productionSecurityMetadataPlugin(): Plugin {
  return {
    name: 'inject-production-security-metadata',
    apply: 'build',
    transformIndexHtml: productionSecurityMetaTags,
  }
}
