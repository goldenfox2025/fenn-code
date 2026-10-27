# Reply presentation

- `Transcript.tsx` in the parent directory orders messages, handles reading position and composes the reply.
- `TurnTools.tsx` owns tool titles, adjacent-call summaries and expandable inputs/results.
- `TurnDisclosure.tsx` supplies the same disclosure control for tools, thought summaries and plans.
- `TurnFooter.tsx` owns copy and secondary actions at settled reply boundaries.
- `CopyButton.tsx` is shared by message and code copying.

Block grouping stays in `src/renderer/src/turn.ts`. Runtime message states come from `ChatService`; do not infer task completion from words in a reply. Existing transcript and turn styles remain in `styles/03-transcript.css` and `styles/16-turn.css`.
