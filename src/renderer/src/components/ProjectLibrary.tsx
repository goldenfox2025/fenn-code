import { useMemo } from 'react'
import type { Project } from '@shared/model'
import { projectFilesLibraryId } from '@shared/library'
import { api, useApp } from '../store'
import { t } from '../i18n'
import { LibraryIndex } from './LibraryIndex'

export function ProjectLibrary({ project, onBrowseChange }: { project: Project; onBrowseChange?: (browsing: boolean) => void }) {
  const language = useApp(s => s.settings.language)
  const sources = useMemo(() => [
    { key: 'workspace', id: project.id, label: t('工作文件'), chooseFolder: async () => { const cwd = await api().pickFolder(); if (cwd) await api().updateProject(project.id, { cwd }) } },
    { key: 'attachments', id: projectFilesLibraryId(project.id), label: t('添加的文件') }
  ], [project.id, project.cwd, language])
  return <LibraryIndex sources={sources} conversationId={project.conversationId} className="project-library" onBrowseChange={onBrowseChange} />
}
