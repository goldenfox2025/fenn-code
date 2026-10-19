import { resolve } from 'path'
import { defineConfig } from 'vitest/config'
export default defineConfig({ resolve: { alias: { '@shared': resolve('src/shared') } }, test: { include: ['test/**/*.test.ts'], setupFiles: ['test/setup.ts'], testTimeout: 20000 } })
