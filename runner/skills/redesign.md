# Redesign rules (layout / CSS changes)

- You work through block-inner replacements (plus inserts for new blocks) —
  there is no stylesheet access. Express visual changes with the structures
  available inside the blocks you edit: element choice, ordering, classes that
  already exist in the document, and inline `style` on elements you emit.
- Prefer reusing class names visible in the block or elsewhere on the page over
  inventing new ones — new classes have no stylesheet backing them.
- Keep inline styles small and purposeful (spacing, alignment, emphasis). Do
  not inline a whole design system; if the ask needs stylesheet-level changes,
  defer with a note describing the CSS that should change and where.
- Never emit `<style>` or `<script>` elements, and never use `!important`.
- Preserve reading order when rearranging content: the DOM order you emit is
  the order screen readers and keyboard users get.
- Use semantic elements for structure (`ul`/`ol` for lists, `table` only for
  tabular data, headings only for real headings) — not `div`s styled to look
  like them.
- Respect the page's existing spacing and typography scale; eyeball what the
  neighboring blocks do and stay consistent with it.
- A layout ask may span multiple blocks: edit each affected block (one edit
  per block). Only what block edits and inserts cannot express — stylesheet
  changes, wrappers around several blocks — goes in the decision note instead.
