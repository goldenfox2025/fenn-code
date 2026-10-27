export interface MemorySkill { id: string; name: string; description: string }
export interface MemoryInput { text: string; files?: { name: string; text: string }[]; skills?: string[] }
export interface MemoryDraft { name: string; description: string; type: 'user' | 'feedback' | 'project' | 'reference'; body: string }
