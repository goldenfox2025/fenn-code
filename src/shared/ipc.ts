/** Methods of AncoraApi that map 1:1 onto AppCore and travel over IPC as `oc:<name>`. */
export const API_METHODS = [
  'snapshot', 'messages', 'startChat', 'send', 'regenerate', 'editMessage', 'switchVariant', 'cancel', 'setModel',
  'updateConversation', 'deleteConversation', 'react', 'createProject', 'updateProject', 'deleteProject',
  'saveRoutine', 'deleteRoutine', 'runRoutineNow', 'listMemory', 'saveMemory', 'deleteMemory',
  'search', 'chooseDecision', 'sendToThread', 'cancelPeerMessage', 'artifactInfo', 'artifactSource', 'listConnectors', 'saveConnector', 'deleteConnector', 'reloadBackends', 'backendsConfigStatus', 'appInfo', 'convertToThread', 'checkForUpdates', 'backendAuthMethods', 'backendLogin', 'backendTerminalLogin', 'listProjectFiles', 'addProjectFiles', 'deleteProjectFile', 'updateProgress', 'deleteProgress', 'foldersInText', 'suggestFolders', 'setOption', 'setOptionDefault', 'backendAccount', 'backendLatestVersion', 'backendImages', 'openOutput', 'upgradeBackend',
  'updateSettings', 'setBackendSetting', 'respondPermission', 'backendModels', 'setModelDefault', 'backendCredits', 'prepareConversation', 'openLogFolder'
] as const
