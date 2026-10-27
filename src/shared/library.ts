/** Internal source ID: stored project attachments use the ordinary file library/editor. */
export const projectFilesLibraryId = (projectId: string) => `project-files:${projectId}`
export const projectFilesOwner = (libraryId: string) => libraryId.startsWith('project-files:') ? libraryId.slice('project-files:'.length) : undefined
