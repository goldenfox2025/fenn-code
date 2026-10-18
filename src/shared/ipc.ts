import type { FennApi } from './model'

/** Methods of FennApi that map 1:1 onto AppCore and travel over IPC as `oc:<name>`. */
export const API_METHODS = [
  'snapshot', 'messages', 'startChat', 'send', 'regenerate', 'editMessage', 'switchVariant', 'cancel', 'setModel',
  'updateConversation', 'deleteConversation', 'react', 'createProject', 'updateProject', 'deleteProject',
  'saveRoutine', 'deleteRoutine', 'runRoutineNow', 'listMemory', 'saveMemory', 'deleteMemory',
  'search', 'queuedMessage', 'chooseDecision', 'sendToThread', 'cancelPeerMessage', 'compactContext', 'runCommand', 'stopCommand', 'commandOutput', 'artifactInfo', 'artifactSource', 'listConnectors', 'saveConnector', 'deleteConnector', 'reloadBackends', 'backendsConfigStatus', 'appInfo', 'usageCalendar', 'convertToThread', 'checkForUpdates', 'backendAuthMethods', 'backendLogin', 'backendTerminalLogin', 'listProjectFiles', 'listLibrary', 'libraryChanges', 'readLibraryFile', 'openLibraryPath', 'addToLibrary', 'makeDefaultFolder', 'addProjectFiles', 'deleteProjectFile', 'updateProgress', 'deleteProgress', 'foldersInText', 'suggestFolders', 'setOption', 'setOptionDefault', 'backendAccount', 'backendLatestVersion', 'openOutput', 'upgradeBackend',
  'updateSettings', 'setBackendSetting', 'respondPermission', 'backendModels', 'setModelDefault', 'backendCredits', 'prepareConversation', 'warmBackend', 'openLogFolder',
  'pickFolder', 'exportConversation', 'openConfigFolder'
] as const satisfies readonly (keyof CoreApi)[]

/** What the core answers over IPC: everything in FennApi but what the preload provides itself. */
export type CoreApi = Omit<FennApi, 'onEvent' | 'platform' | 'windowControl'>
export type ApiMethod = (typeof API_METHODS)[number]

// Every CoreApi method is in the list (a missing one fails here, naming it).
const everyMethodListed: Record<Exclude<keyof CoreApi, ApiMethod>, never> = {}
void everyMethodListed
