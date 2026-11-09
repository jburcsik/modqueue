import { defineConfig, devices } from '@playwright/test'

try {
  process.loadEnvFile('.env.local')
} catch {
  // Without .env.local the variables must already be in the environment.
}

const port = Number(process.env.PORT ?? 3100)
const baseURL = `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Builds, then serves on the same port the tests target.
  webServer: {
    command: `npx next build && npx next start --port ${port}`,
    url: baseURL,
    reuseExistingServer: true,
    timeout: 240_000,
  },
})
