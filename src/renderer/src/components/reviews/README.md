# Project review UI

- `ThreadReview.tsx`: compact review card docked outside history, above the composer. A distinct bounded inspector holds details and a revision-scoped comment editor without resizing the lower card or transcript. Comments ask the coordinator to discuss and decide the next step; they do not restart the worker or force navigation.
- `ReviewActions.tsx`: shared decision controls, keeping the primary action readable and collapsing the secondary label only when actual space is insufficient.
- `ReviewDetails.tsx`: files first, then feedback, coordinator analysis and evidence, with an independent preserved scroll position.
- `ReviewFeedback.tsx`: comment field and submission footer inside the inspector. Drafts and submission remain in `ThreadReview`.
- `ReviewFilesPanel.tsx`: read-only submitted diff/source preview in the shared library surface. Editor metadata and contextual actions live in its header.
- `reviewState.ts`: labels for the existing thread groups and review outcome.

`ProjectView.tsx` owns thread navigation and keeps the thread mounted while inspecting files. Its `thread-reading-area` provides the inspector's portal host. CSS constrains the inspector to that area, with no asynchronous measurement or reserved transcript space. There is no separate review queue or sidebar mode. Shared responsive panel navigation lives in `OverflowTabs.tsx`; composer fitting lives in `useComposerFit.ts`. Styling uses `styles/23-project-review.css` and existing tokens.

All short mutually exclusive choices use `SegmentedControl.tsx`, including appearance, connector kind, file view mode and permission tiers. Common fields, buttons, focus and selection styling belongs in `styles/02-controls.css`; generic compact panel states belong in `styles/07-panel.css`. The review stylesheet only owns review and submitted-file presentation. `PreviewPane.tsx` owns responsive geometry for page previews, local files and ordinary chat side panes; the thread layout variant gives submitted files the same geometry as the conversation being inspected.

Git worktrees, submission identity, conflict/staleness checks and human approval rules belong in `src/main/core/ProjectReviews.ts`. The renderer does not decide merge safety or modify submitted source.
