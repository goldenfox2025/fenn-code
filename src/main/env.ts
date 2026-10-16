/**
 * The app used to be called openclaude, then Cove: their OPENCLAUDE_* and
 * COVE_* environment variables still work as ANCORA_*. Imported first so
 * everything sees them.
 */
for (const old of ['COVE_', 'OPENCLAUDE_'])
  for (const [k, v] of Object.entries(process.env))
    if (k.startsWith(old) && v !== undefined) {
      const now = 'ANCORA_' + k.slice(old.length)
      if (process.env[now] === undefined) process.env[now] = v
    }

export {}
