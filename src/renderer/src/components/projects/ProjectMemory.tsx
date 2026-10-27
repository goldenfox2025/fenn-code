import { NotebookText } from 'lucide-react'
import { useApp, api } from '../../store'
import { t } from '../../i18n'
import { MemoryManager, type MemoryService } from '../MemoryManager'
import { ProjectSection } from './ProjectSection'

const service: MemoryService = {
  list: (scope) => api().listMemory(scope),
  save: (scope, entry) => api().saveMemory(scope, entry),
  remove: (scope, name) => api().deleteMemory(scope, name)
  , skills: scope => api().listMemorySkills(scope)
  , compose: (scope, input) => api().composeMemory(scope, input)
}

export function MemoryPanel({ projectId }: { projectId: string }) {
  const version = useApp((state) => state.memoryVersion[projectId] ?? 0)
  return <ProjectSection title={t('项目记忆')} icon={<NotebookText size={18} />}>
    <MemoryManager scope={projectId} version={version} service={service} translate={t} />
  </ProjectSection>
}
