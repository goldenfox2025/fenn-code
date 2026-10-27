# UI ownership

Use the existing product tokens and shared controls before introducing another local treatment.

| Change | Owner |
| --- | --- |
| Colors, spacing, radius, type and motion values | `../tokens.css` |
| Buttons, text fields, focus and segmented selection styling | `../styles/02-controls.css` |
| Short exclusive choices and native radio keyboard behavior | `SegmentedControl.tsx` |
| Menus, dropdown placement, overflow and keyboard selection | `Menu.tsx` |
| Main-branch pane navigation | `SidePane.tsx`, `../views/ProjectView.tsx`; shared tab keys in `OverflowTabs.tsx` |
| Project/chat pane expand and restore control | `PaneSizeButton` in `PreviewPane.tsx`; both entry points retain the same `FilesPane` instance while changing width |
| Preview/ordinary chat pane dimensions and floating behavior | `PreviewPane.tsx`, `ResizeHandle.tsx`, `.page-panel` rules in `../styles/10-composer-extras.css` |
| Modal naming, focus containment, Escape and focus restoration | `Modal.tsx` |
| Panel loading/empty/error presentation | `PanelState.tsx` and `../styles/07-panel.css` |
| Review draft/controller, evidence and decision presentation | `reviews/README.md` |
| Reply progress, grouped tools and settled reply actions | `transcript/README.md` |
| Project/chat files, tree actions and safe editing | `FilesPane.tsx`, `../styles/17-side-pane.css`; uploaded project files use `projectFilesLibraryId` |
| Project information hierarchy and schedules | `projects/ProjectSection.tsx`, `projects/ProjectSchedules.tsx` |
| Scoped durable-memory management | `MemoryManager.tsx`, `../styles/25-memory.css`; project adapter in `projects/ProjectMemory.tsx` |
| Default user/assistant fennec identity | `FoxAvatar.tsx`, `../styles/24-fox-avatar.css` |

Views own navigation and data flow; shared controls own their interaction contract. Feature CSS adds layout rather than redefining shared control colors, radii or focus. Test utilities use isolated profiles and keep test agents out of normal application settings.

| Automatic input sources and conclusions | `ConversationResources.tsx` (view), `../../../main/core/ConversationContext.ts` (selection/provenance) |
| Shared disclosure heading | `OverviewSection.tsx` |
| Conversation file/background destinations | `SidePane.tsx` |
| Background task rows, history and command output | `background/BackgroundPanel.tsx`, `background/CommandOutput.tsx`, `../styles/29-background.css`; scope and status in `../../../shared/backgroundTasks.ts` |
| User-turn nodes, reply previews and hover ridge | `ConversationNodes.tsx`, `../../../shared/conversationIndex.ts`, `../styles/28-conversation-nodes.css` (explicitly synced to Bot) |

Latest instruction (2026-10-26): Code's right sidebar is restored to the default branch's opaque pane, text tabs and secondary menu. Ordinary chats use Files/Background with actual child conversations under Background; projects use Threads/Library. The existing FilesPane owns editing. Retain review, safe-save, lifecycle and accessibility improvements; stop redesigning this sidebar. Bot retains its docked inspector. LibraryIndex/ChatLibrary/ProjectLibrary/ConversationResources are retained prototypes, not mounted Code sidebar routes.
