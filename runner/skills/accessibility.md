# Accessibility rules (a11y)

- Prefer native semantics over ARIA: a real `<button>`, `<a href>`, `<ul>`, or
  heading beats a `div` with a `role`. Add ARIA only when no native element
  expresses the semantics ("no ARIA is better than bad ARIA").
- Every meaningful image gets descriptive `alt` text that conveys its purpose;
  decorative images get `alt=""`. Never leave `alt` absent.
- Link and button text must make sense out of context: "download the 2026
  report", not "click here". Do not rely on color or position alone to convey
  meaning — pair color cues with text or markup.
- Keep the heading hierarchy intact: do not skip levels or promote/demote a
  heading just for its visual size.
- Preserve focus order: DOM order is focus order. Do not use positive
  `tabindex`, and do not reorder interactive elements in a way that breaks the
  logical tab sequence.
- Contrast: body text needs at least 4.5:1 against its background (3:1 for
  large text, WCAG AA). If you set colors inline, pick values that clear this;
  if the fix requires stylesheet changes you cannot make, defer with the
  specific ratio problem in the note.
- Label form controls with a real `<label>` (or `aria-label` when a visible
  label is impossible); state units and formats in the label, not only in
  placeholder text.
- When an a11y fix needs changes outside any `data-rev` block (`lang`
  attributes on `<html>`, `<head>` metadata, stylesheet contrast), fix what
  block edits and inserts can reach and spell out the rest in the decision
  note.
