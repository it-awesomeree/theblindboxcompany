import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173/theblindboxcompany/',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run build && npm exec vite preview -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173/theblindboxcompany/',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    { name: 'chrome-desktop', use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 1440, height: 900 } } },
    { name: 'mobile-360', use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true } },
    { name: 'mobile-390', use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: 'mobile-430', use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true } },
    { name: 'tablet-768', use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 768, height: 1024 }, isMobile: true, hasTouch: true } },
  ],
})
