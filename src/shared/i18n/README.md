# Translations

Every user-facing string in Fenn Code lives in this folder.

- The source language is Simplified Chinese, and the Chinese text itself is the
  key: code calls `t('已完成：{0}', name)`. `{0}`, `{1}`… are filled from the
  arguments.
- Strings defined before the language is known (plugin descriptions, hints,
  setting labels) are marked with `tk('…')` and translated with `t()` where
  they are shown.
- Each other language is one file mapping the Chinese keys to its own text
  (see `en.ts`). A key a language leaves out falls back to Chinese.

## Adding a language

1. Copy `en.ts` to `<code>.ts` (for example `ja.ts`) and translate the values.
2. Add it to `LANGS` in `index.ts`, with its own name, and widen the `Lang` type.
3. If system locales should pick it, extend `resolveLang` and `localeTag`.
4. Run `npx vitest run test/i18n.test.ts`. It fails on any string marked
   with `t()` or `tk()` that `en.ts` lacks, and on Chinese text in the UI
   that isn't wrapped in `t()`.

`scripts/i18n-add.mjs '{"中文": "English"}'` appends English entries.

Prompts and tool descriptions written for the agent (in `src/main/core` and
`src/main/computer`) are not UI text and stay in Chinese; the agent is told to
reply in the user's language.
