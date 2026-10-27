import { describe, expect, it } from 'vitest'
import { makeCore } from './helpers'
import { projectFilesLibraryId } from '../src/shared/library'

describe('unified project library', () => {
  it('opens and edits existing project attachments without requiring a working folder', async () => {
    const { core, dispose } = await makeCore()
    try {
      const project = await core.createProject({ name: 'Library', backendId: 'mock' })
      const scope = projectFilesLibraryId(project.id)
      await core.addProjectFiles(project.id, [{ name: 'brief.md', data: Buffer.from('# Original\r\n').toString('base64') }])
      const listed = await core.listLibrary(scope)
      expect(listed?.entries.map((entry) => entry.name)).toEqual(['brief.md'])
      const before = await core.readLibraryFile(scope, 'brief.md')
      expect(before?.readOnly).toBeUndefined()
      await core.saveLibraryFile(scope, 'brief.md', '# Updated\r\n', before?.updatedAt)
      expect(core.files.read(project.id, 'brief.md')).toMatchObject({ kind: 'text', text: '# Updated\r\n' })
      const file = core.files.list(project.id)[0]
      expect(await core.locateFile(file.path, project.conversationId)).toEqual({ libraryId: scope, rel: 'brief.md' })
      await core.renameLibraryPath(scope, 'brief.md', 'plan.md')
      expect(core.files.list(project.id).map((entry) => entry.name)).toEqual(['plan.md'])
      expect(await core.readLibraryFile(scope, '../state.json')).toBeUndefined()
      expect(await core.listLibrary(projectFilesLibraryId('missing-project'))).toBeUndefined()
    } finally { await dispose() }
  })
  it('retains conflict protection when another writer changes an attachment', async () => {
    const { core, dispose } = await makeCore()
    try {
      const project = await core.createProject({ name: 'Library conflicts', backendId: 'mock' })
      const scope = projectFilesLibraryId(project.id)
      await core.addProjectFiles(project.id, [{ name: 'note.md', data: Buffer.from('original').toString('base64') }])
      await core.addProjectFiles(project.id, [{ name: 'note.md', data: Buffer.from('agent revision').toString('base64') }])
      const result = await core.saveLibraryFile(scope, 'note.md', 'local draft', 0)
      expect(result).toEqual({ conflict: true })
      expect(core.files.read(project.id, 'note.md')).toMatchObject({ text: 'agent revision' })
    } finally { await dispose() }
  })
})
