import { projectFilesLibraryId } from '@shared/library'

// Library paths from disk are relative. This absolute namespace exists only in
// the tree, so an uploaded file can never collide with a working-folder file.
export const MATERIALS = '/@materials'
export const isMaterialPath = (path: string) => path === MATERIALS || path.startsWith(MATERIALS + '/')
export const materialPath = (path: string) => path ? `${MATERIALS}/${path}` : MATERIALS

export interface LibraryLocation { id: string; path: string }

/** Resolve a tree entry before any read, write or system action. */
export function libraryLocation(id: string, path: string, project: boolean): LibraryLocation {
  return project && isMaterialPath(path)
    ? { id: projectFilesLibraryId(id), path: path.slice(MATERIALS.length).replace(/^\//, '') }
    : { id, path }
}
