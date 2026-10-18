import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const commit = (() => {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return ''
  }
})()
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: {
      __OC_COMMIT__: JSON.stringify(process.env.OC_COMMIT ?? commit),
      __OC_BUILT_AT__: JSON.stringify(new Date().toISOString().slice(0, 10)),
      // Release channel for "check for updates" (a JSON {version, url, notes}); empty until there is one.
      __OC_UPDATE_FEED__: JSON.stringify(pkg.fenn?.updateFeed ?? '')
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } } }
  },
  renderer: {
    root: 'src/renderer',
    resolve: { alias: { '@shared': resolve('src/shared') } },
    plugins: [react()]
  }
})
