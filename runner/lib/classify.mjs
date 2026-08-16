// runner/lib/classify.mjs — heuristic comment-archetype classifier.
//
// classify(commentBody) buckets a review comment into one of five archetypes
// so /api/run can pick a model (config.models[archetype]). Deliberately
// simple and transparent: ordered keyword/pattern rules, first match wins,
// default "tactical" (small targeted fix — the safest and cheapest lane).
//
// Rule order encodes specificity: accessibility asks often also mention
// styling words ("contrast", "focus ring"), so a11y is checked before
// redesign; research asks may mention rewriting, so research precedes
// content. Keep the patterns boring — a wrong bucket only picks a different
// model, it never changes what the agent is allowed to do.

export const ARCHETYPES = Object.freeze([
  'tactical',
  'redesign',
  'research',
  'accessibility',
  'content',
]);

const RULES = [
  // accessibility: assistive-tech and a11y-spec vocabulary.
  ['accessibility',
    /\b(a11y|accessib\w*|aria[\w-]*|alt[\s-]?(text|attribute)s?|screen[\s-]?reader|wcag|contrast|keyboard[\s-]?(nav\w*|access\w*|focus)|focus[\s-]?(ring|order|state|visible)|tab[\s-]?order)\b/i],
  // research: asks to verify, source, or bring in outside/current facts.
  ['research',
    /\b(research|look\s+(this\s+|it\s+)?up|fact[\s-]?check|verify|citations?|cite|sources?|up[\s-]?to[\s-]?date|latest\s+(data|numbers|figures|stats|version)|double[\s-]?check)\b/i],
  // redesign: layout / CSS / visual-structure vocabulary.
  ['redesign',
    /\b(redesign|re-?lay\s?out|layout|restructure|css|styl(e|es|ing)|spacing|margins?|padding|typography|fonts?|colou?rs?|palette|responsive|grid|flex(box)?|columns?|visual(ly)?|whitespace|align(ment|ed)?)\b/i],
  // content: prose-level rewriting and tone work.
  ['content',
    /\b(rewrite|re-?word(ed|ing)?|rephrase|tone|voice|shorten|tighten|condense|expand|elaborate|summar(y|ize|ise|izing)|clarify|simplify|wordy|verbose|copy[\s-]?edit(ing)?|prose|paragraphs?)\b/i],
];

// Classify a comment body into an archetype. Non-string or unmatched input
// falls through to "tactical".
export function classify(commentBody) {
  const body = typeof commentBody === 'string' ? commentBody : '';
  for (const [archetype, pattern] of RULES) {
    if (pattern.test(body)) return archetype;
  }
  return 'tactical';
}
