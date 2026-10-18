/**
 * The app used to be called openclaude, then Cove, then Ancora: their
 * OPENCLAUDE_*, COVE_* and ANCORA_* environment variables still work as
 * FENN_*. Imported first so everything sees them.
 */
for (const old of ['ANCORA_', 'COVE_', 'OPENCLAUDE_'])
  for (const [k, v] of Object.entries(process.env))
    if (k.startsWith(old) && v !== undefined) {
      const now = 'FENN_' + k.slice(old.length)
      if (process.env[now] === undefined) process.env[now] = v
    }

export {}
