import { describe, expect, it } from 'vitest'
import { mergePath, usualBinDirs } from '../src/main/loginPath'

describe('PATH for an app opened from the Dock', () => {
  it('adds Homebrew, npm, Volta and nvm places that exist, newest Node first, even when the login shell gave nothing', () => {
    const have = new Set(['/opt/homebrew/bin', '/usr/local/bin', '/Users/u/.volta/bin', '/Users/u/.nvm/versions/node/v22.3.0/bin', '/Users/u/.nvm/versions/node/v9.11.2/bin', '/Users/u/.nvm/versions/node/v20.10.0/bin'])
    const dirs = usualBinDirs('/Users/u', 'darwin', (d) => have.has(d), () => ['v9.11.2', 'v22.3.0', 'v20.10.0', 'system'])
    expect(dirs).toEqual(['/opt/homebrew/bin', '/usr/local/bin', '/Users/u/.volta/bin', '/Users/u/.nvm/versions/node/v22.3.0/bin', '/Users/u/.nvm/versions/node/v20.10.0/bin', '/Users/u/.nvm/versions/node/v9.11.2/bin'])
    expect(mergePath(undefined, '/usr/bin:/bin', dirs).split(':').slice(0, 3)).toEqual(['/usr/bin', '/bin', '/opt/homebrew/bin'])
    expect(mergePath('/a:/usr/bin', '/usr/bin:/bin', ['/a', '/c'])).toBe('/a:/usr/bin:/bin:/c')
    expect(usualBinDirs('/home/u', 'linux', (d) => d === '/opt/homebrew/bin' || d === '/home/u/.local/bin', () => [])).toEqual(['/home/u/.local/bin'])
    expect(usualBinDirs('C:\\Users\\u', 'win32')).toEqual([])
  })
})
