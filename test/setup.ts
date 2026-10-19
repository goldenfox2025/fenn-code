import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'

// Tests build their expected paths from tmpdir(), and the app compares real paths. macOS's temp folder
// sits behind a link (/var → /private/var), Windows's can be a short 8.3 name (RUNNER~1): use its real path.
const real = realpathSync.native(tmpdir())
for (const key of ['TMPDIR', 'TEMP', 'TMP']) process.env[key] = real
