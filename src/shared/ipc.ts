import type { FennApi } from './model'

/** Methods of FennApi that map 1:1 onto AppCore and travel over IPC as `oc:<name>`. */
export const API_METHODS = [
  'browserInfo', 'browserFrame', 'stopBrowser',
  'snapshot', 'messages', 'organizeContext', 'startChat', 'send', 'regenerate', 'editMessage', 'switchVariant', 'cancel', 'setModel',
  'updateConversation', 'deleteConversation', 'inspectDelivery', 'deliveryFile', 'acceptDelivery', 'returnDelivery', 'discussDelivery', 'createProject', 'updateProject', 'deleteProject',
  'saveRoutine', 'deleteRoutine', 'locateFile', 'readLocalFile', 'runRoutineNow', 'listMemory', 'listMemorySkills', 'composeMemory', 'saveMemory', 'deleteMemory',
  'search', 'queuedMessage', 'chooseDecision', 'sendToThread', 'cancelPeerMessage', 'compactContext', 'runCommand', 'stopCommand', 'commandOutput', 'artifactInfo', 'artifactSource', 'listConnectors', 'saveConnector', 'deleteConnector', 'reloadBackends', 'backendsConfigStatus', 'appInfo', 'usageCalendar', 'convertToThread', 'checkForUpdates', 'backendAuthMethods', 'backendLogin', 'backendTerminalLogin', 'listProjectFiles', 'listLibrary', 'libraryChanges', 'readLibraryFile', 'openLibraryPath', 'addToLibrary', 'renameLibraryPath', 'createLibraryEntry', 'saveLibraryFile', 'deleteLibraryPath', 'makeDefaultFolder', 'addProjectFiles', 'deleteProjectFile', 'updateProgress', 'deleteProgress', 'foldersInText', 'suggestFolders', 'setOption', 'setOptionDefault', 'backendAccount', 'backendLatestVersion', 'openOutput', 'upgradeBackend',
  'updateSettings', 'setBackendSetting', 'respondPermission', 'backendModels', 'setModelDefault', 'backendCredits', 'prepareConversation', 'warmBackend', 'openLogFolder',
  'pickFolder', 'exportConversation', 'openConfigFolder', 'moveLibraryPath'
] as const satisfies readonly (keyof CoreApi)[]

/** What the core answers over IPC: everything in FennApi but what the preload provides itself. */
export type CoreApi = Omit<FennApi, 'onEvent' | 'platform' | 'windowControl'>
export type ApiMethod = (typeof API_METHODS)[number]

// Every CoreApi method is in the list (a missing one fails here, naming it).
const everyMethodListed: Record<Exclude<keyof CoreApi, ApiMethod>, never> = {}
void everyMethodListed
