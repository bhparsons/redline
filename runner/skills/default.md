# Default editing rules

These rules apply to every edit, in every archetype.

- New sibling blocks go through `inserts`; never smuggle a structural addition
  into an existing block's inner.
- Escape a literal `<`, `>` or `&` in text as an entity, and emit balanced,
  well-formed markup — every tag you open inside the block, you close.
- Keep markup minimal: prefer the tags already used in the block. Do not add
  wrapper `div`s, ids, event handlers, or `<script>`/`<style>` elements.
- Match the document's existing tone and voice. An edit should read as if the
  original author wrote it.
- Change the least amount necessary to address the comment. Do not "improve"
  text the reviewer did not ask about. Text you are not changing must be
  re-emitted byte-for-byte — same wording, same entities, same attributes —
  never paraphrased or reformatted in passing.
- Never add HTML comments to the document ("fixed per review", TODOs, or any
  other annotation). Explanations belong in the decision summary and note,
  not in the document.
