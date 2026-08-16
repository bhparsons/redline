// runner/eval/fixtures.mjs — the eval benchmark's fixture set.
//
// 22 fixtures: 4 per archetype (tactical, redesign, research, accessibility,
// content) plus 2 SECTION-anchored cases (WP2/WP5 — the comment anchors to a
// stamped <section> and a correct run edits the child blocks). Each fixture
// is one realistic review comment against one realistic data-rev block, plus
// everything needed to score a run offline:
//
//   name                 unique fixture id (also the --only filter key)
//   body                 the review comment (MUST classify to expectedArchetype
//                        — test/runner/eval.test.mjs enforces this)
//   blockHtml            the full block element, data-rev id included, that
//                        the harness wraps into a temp page (see buildDoc)
//   expectedArchetype    what classify(body) must return
//   expectedBlockId      the data-rev id a correct edit targets (for section
//                        fixtures: the SECTION id the comment anchors to)
//   expectedBlockIds     section fixtures only: the child block ids a
//                        correct run may edit (scored as a set)
//   expectedDecision     addressed | declined | deferred
//   expectsEdit          whether a correct run edits the block (addressed
//                        runs may legitimately carry no edit — e.g. research
//                        that confirms the claim and cites in the note)
//   expectedInnerPattern RegExp or predicate(afterInner) => boolean|0..1,
//                        judged against the applied inner HTML; null when
//                        expectsEdit is false
//   stubResponse         the agent JSON a well-behaved model would return;
//                        '{{COMMENT_ID}}' is substituted with the real minted
//                        comment id at run time, so the harness is fully
//                        runnable offline against the built-in stub server
//
// Fixtures are data, not tests: the harness must exit 0 however they score.

export const COMMENT_ID_PLACEHOLDER = '{{COMMENT_ID}}';

// Wrap one fixture block into a minimal, ASCII-only page the runner can
// serve and edit. Shared by the harness (temp docs) and score.mjs
// (applied-cleanly re-validation).
export function buildDoc(blockHtml) {
  return '<!doctype html>\n<html><head><title>redline eval fixture</title></head>\n<body>\n<main>\n'
    + blockHtml
    + '\n</main>\n</body></html>\n';
}

function fixture(def) {
  return Object.freeze(def);
}

function stub(decision, summary, edits = [], note = undefined) {
  const d = { id: COMMENT_ID_PLACEHOLDER, decision, summary };
  if (note !== undefined) d.note = note;
  return { decisions: [d], edits };
}

// Inner HTML the c2 block starts with — the predicate needs it to check the
// rewrite actually changed something.
const C2_BEFORE = 'Users must not share passwords. Violations result in account termination.';

export const FIXTURES = Object.freeze([
  // ---- tactical (small targeted fixes; default archetype) -------------------
  fixture({
    name: 'tactical-typo',
    body: 'Typo: "recieve" should be "receive".',
    blockHtml: '<p data-rev="r-ev-t1">You will recieve a confirmation email within two days.</p>',
    expectedArchetype: 'tactical',
    expectedBlockId: 'r-ev-t1',
    expectedDecision: 'addressed',
    expectsEdit: true,
    expectedInnerPattern: /\breceive a confirmation email\b/,
    stubResponse: stub('addressed', 'Fixed the "recieve" typo.', [
      { blockId: 'r-ev-t1', newInner: 'You will receive a confirmation email within two days.' },
    ]),
  }),
  fixture({
    name: 'tactical-wrong-year',
    body: 'Wrong year: the launch happened in 2025, not 2024.',
    blockHtml: '<p data-rev="r-ev-t2">The beta launched in 2024 and reached 10,000 users in its first quarter.</p>',
    expectedArchetype: 'tactical',
    expectedBlockId: 'r-ev-t2',
    expectedDecision: 'addressed',
    expectsEdit: true,
    expectedInnerPattern: (inner) => inner.includes('2025') && !inner.includes('2024'),
    stubResponse: stub('addressed', 'Corrected the launch year to 2025.', [
      { blockId: 'r-ev-t2', newInner: 'The beta launched in 2025 and reached 10,000 users in its first quarter.' },
    ]),
  }),
  fixture({
    name: 'tactical-fix-href',
    body: 'This link should point to /docs/setup.html instead of /setup.html.',
    blockHtml: '<p data-rev="r-ev-t3">See the <a href="/setup.html">setup guide</a> for details.</p>',
    expectedArchetype: 'tactical',
    expectedBlockId: 'r-ev-t3',
    expectedDecision: 'addressed',
    expectsEdit: true,
    expectedInnerPattern: /<a href="\/docs\/setup\.html">setup guide<\/a>/,
    stubResponse: stub('addressed', 'Repointed the link at /docs/setup.html.', [
      { blockId: 'r-ev-t3', newInner: 'See the <a href="/docs/setup.html">setup guide</a> for details.' },
    ]),
  }),
  fixture({
    name: 'tactical-ambiguous-decline',
    body: 'Fix the number here.',
    blockHtml: '<p data-rev="r-ev-t4">Plan A costs $40 per seat; Plan B costs $90 per seat.</p>',
    expectedArchetype: 'tactical',
    expectedBlockId: 'r-ev-t4',
    expectedDecision: 'declined',
    expectsEdit: false,
    expectedInnerPattern: null,
    stubResponse: stub('declined',
      'Ambiguous ask: the block has two numbers and the comment names neither.',
      [],
      'Both $40 and $90 appear in this block; please say which figure is wrong and what it should be.'),
  }),

  // ---- redesign (layout / visual structure) ---------------------------------
  fixture({
    name: 'redesign-prose-to-list',
    body: 'This wall of text should be a bulleted list for better layout.',
    blockHtml: '<div data-rev="r-ev-r1">Our onboarding plan includes account provisioning, data migration, admin training, and ongoing support.</div>',
    expectedArchetype: 'redesign',
    expectedBlockId: 'r-ev-r1',
    expectedDecision: 'addressed',
    expectsEdit: true,
    expectedInnerPattern: (inner) => /<ul>/.test(inner) && (inner.match(/<li>/g) ?? []).length >= 3,
    stubResponse: stub('addressed', 'Converted the sentence to a bulleted list.', [
      {
        blockId: 'r-ev-r1',
        newInner: 'Our onboarding plan includes:<ul><li>account provisioning</li><li>data migration</li><li>admin training</li><li>ongoing support</li></ul>',
      },
    ]),
  }),
  fixture({
    name: 'redesign-label-spacing',
    body: 'Add more spacing between the label and the value, maybe with some padding.',
    blockHtml: '<div data-rev="r-ev-r2"><span class="label">Total:</span><span class="value">$1,200</span></div>',
    expectedArchetype: 'redesign',
    expectedBlockId: 'r-ev-r2',
    expectedDecision: 'addressed',
    expectsEdit: true,
    expectedInnerPattern: /style="[^"]*(margin|padding)[^"]*"/,
    stubResponse: stub('addressed', 'Added a small left margin between label and value.', [
      {
        blockId: 'r-ev-r2',
        newInner: '<span class="label">Total:</span><span class="value" style="margin-left: 0.5em">$1,200</span>',
      },
    ]),
  }),
  fixture({
    name: 'redesign-heading-structure',
    body: 'Restructure this so the product name is a proper heading above the description.',
    blockHtml: '<div data-rev="r-ev-r3"><p><b>Acme Sync</b> keeps your files consistent across all of your devices.</p></div>',
    expectedArchetype: 'redesign',
    expectedBlockId: 'r-ev-r3',
    expectedDecision: 'addressed',
    expectsEdit: true,
    expectedInnerPattern: /<h[2-4]>Acme Sync<\/h[2-4]>/,
    stubResponse: stub('addressed', 'Promoted the product name to a heading.', [
      {
        blockId: 'r-ev-r3',
        newInner: '<h3>Acme Sync</h3><p>Keeps your files consistent across all of your devices.</p>',
      },
    ]),
  }),
  fixture({
    name: 'redesign-defer-stylesheet',
    body: 'The whole page needs a two-column grid; make this section responsive.',
    blockHtml: '<div data-rev="r-ev-r4"><p>Feature highlights and pricing details share this section.</p></div>',
    expectedArchetype: 'redesign',
    expectedBlockId: 'r-ev-r4',
    expectedDecision: 'deferred',
    expectsEdit: false,
    expectedInnerPattern: null,
    stubResponse: stub('deferred',
      'A page-wide responsive grid needs stylesheet changes outside this block.',
      [],
      'Suggest a stylesheet rule like main { display: grid; grid-template-columns: 1fr 1fr; } with a single-column breakpoint under 40em; inlining that on one block would not make the page responsive.'),
  }),

  // ---- research (verify / source / bring in outside facts) ------------------
  fixture({
    name: 'research-verify-population',
    body: 'Please verify this population figure and cite a source.',
    blockHtml: '<p data-rev="r-ev-s1">Iceland has a population of about 500,000 people.</p>',
    expectedArchetype: 'research',
    expectedBlockId: 'r-ev-s1',
    expectedDecision: 'addressed',
    expectsEdit: true,
    expectedInnerPattern: (inner) => !inner.includes('500,000'),
    stubResponse: stub('addressed', 'Corrected the population figure per Statistics Iceland.', [
      { blockId: 'r-ev-s1', newInner: 'Iceland has a population of about 390,000 people.' },
    ], 'Statistics Iceland puts the 2024 population at ~389,000 (https://www.statice.is/).'),
  }),
  fixture({
    name: 'research-node-version',
    body: 'Double-check the minimum version here; it should name the oldest currently-supported LTS line.',
    blockHtml: '<p data-rev="r-ev-s2">The tool requires Node.js 16 or newer.</p>',
    expectedArchetype: 'research',
    expectedBlockId: 'r-ev-s2',
    expectedDecision: 'addressed',
    expectsEdit: true,
    expectedInnerPattern: (inner) => /Node\.js (2\d|[3-9]\d)/.test(inner) && !/Node\.js 16/.test(inner),
    stubResponse: stub('addressed', 'Bumped the minimum to the oldest supported LTS line.', [
      { blockId: 'r-ev-s2', newInner: 'The tool requires Node.js 20 or newer.' },
    ], 'Node.js 16 and 18 are end-of-life; 20 is the oldest line still in support per the Node.js release schedule (https://nodejs.org/en/about/previous-releases).'),
  }),
  fixture({
    name: 'research-unverifiable-defer',
    body: 'Can you fact-check this claim about market share?',
    blockHtml: '<p data-rev="r-ev-s3">Acme holds 62% of the widget market.</p>',
    expectedArchetype: 'research',
    expectedBlockId: 'r-ev-s3',
    expectedDecision: 'deferred',
    expectsEdit: false,
    expectedInnerPattern: null,
    stubResponse: stub('deferred',
      'Could not verify: no authoritative public source for widget market share.',
      [],
      'No standards body or public filing reports widget market share; the 62% figure appears only in Acme\'s own marketing. Deferring rather than guessing.'),
  }),
  fixture({
    name: 'research-confirm-with-citation',
    body: 'This statistic needs a citation; find a reliable source and correct it if wrong.',
    blockHtml: '<p data-rev="r-ev-s4">Remote workers in the study reported a 13% performance increase.</p>',
    expectedArchetype: 'research',
    expectedBlockId: 'r-ev-s4',
    expectedDecision: 'addressed',
    expectsEdit: false,
    expectedInnerPattern: null,
    stubResponse: stub('addressed',
      'Figure verified as stated; citation in the note.',
      [],
      'Matches Bloom et al., "Does Working from Home Work?" (QJE 2015), which found a 13% performance increase (https://doi.org/10.1093/qje/qju032). No document change needed.'),
  }),

  // ---- accessibility ---------------------------------------------------------
  fixture({
    name: 'a11y-alt-text',
    body: 'This image needs descriptive alt text for screen readers.',
    blockHtml: '<figure data-rev="r-ev-a1"><img src="chart.png"><figcaption>Quarterly revenue &mdash; FY26</figcaption></figure>',
    expectedArchetype: 'accessibility',
    expectedBlockId: 'r-ev-a1',
    expectedDecision: 'addressed',
    expectsEdit: true,
    expectedInnerPattern: /<img [^>]*alt="[^"]{10,}"/,
    stubResponse: stub('addressed', 'Added descriptive alt text to the chart image.', [
      {
        blockId: 'r-ev-a1',
        newInner: '<img src="chart.png" alt="Bar chart of quarterly revenue rising from $2M to $3.5M across FY26"><figcaption>Quarterly revenue &mdash; FY26</figcaption>',
      },
    ]),
  }),
  fixture({
    name: 'a11y-link-text',
    body: 'The link text "click here" fails accessibility guidelines; make it descriptive.',
    blockHtml: '<p data-rev="r-ev-a2">To download the report, <a href="/report.pdf">click here</a>.</p>',
    expectedArchetype: 'accessibility',
    expectedBlockId: 'r-ev-a2',
    expectedDecision: 'addressed',
    expectsEdit: true,
    expectedInnerPattern: (inner) =>
      /<a href="\/report\.pdf">[^<]+<\/a>/.test(inner) && !/click here/i.test(inner),
    stubResponse: stub('addressed', 'Made the link text describe its destination.', [
      { blockId: 'r-ev-a2', newInner: 'You can <a href="/report.pdf">download the report (PDF)</a>.' },
    ]),
  }),
  fixture({
    name: 'a11y-real-button',
    body: 'This fake button is not keyboard accessible; use a real button element.',
    blockHtml: '<div data-rev="r-ev-a3"><span class="btn">Submit request</span></div>',
    expectedArchetype: 'accessibility',
    expectedBlockId: 'r-ev-a3',
    expectedDecision: 'addressed',
    expectsEdit: true,
    expectedInnerPattern: /<button[^>]*>Submit request<\/button>/,
    stubResponse: stub('addressed', 'Replaced the styled span with a native button.', [
      { blockId: 'r-ev-a3', newInner: '<button class="btn" type="submit">Submit request</button>' },
    ]),
  }),
  fixture({
    name: 'a11y-contrast-defer',
    body: 'The gray-on-gray text fails WCAG contrast; needs at least 4.5:1.',
    blockHtml: '<p data-rev="r-ev-a4" class="subtle">Renewal happens automatically unless you cancel 30 days in advance.</p>',
    expectedArchetype: 'accessibility',
    expectedBlockId: 'r-ev-a4',
    expectedDecision: 'deferred',
    expectsEdit: false,
    expectedInnerPattern: null,
    stubResponse: stub('deferred',
      'Contrast comes from the .subtle stylesheet rule, outside this block.',
      [],
      'The color pair is set by the .subtle class in the stylesheet; fix it there (e.g. #595959 on #ffffff clears 7:1). Overriding inline on one paragraph would leave every other .subtle element failing.'),
  }),

  // ---- content (prose rewriting / tightening) --------------------------------
  fixture({
    name: 'content-tighten',
    body: 'This is too wordy; tighten it up.',
    blockHtml: '<p data-rev="r-ev-c1">In order to be able to get started with the product, it is first necessary that you create an account.</p>',
    expectedArchetype: 'content',
    expectedBlockId: 'r-ev-c1',
    expectedDecision: 'addressed',
    expectsEdit: true,
    expectedInnerPattern: (inner) => inner.length < 80 && /account/i.test(inner),
    stubResponse: stub('addressed', 'Cut the filler; same meaning in a third of the words.', [
      { blockId: 'r-ev-c1', newInner: 'To get started, create an account.' },
    ]),
  }),
  fixture({
    name: 'content-friendlier-tone',
    body: 'Rewrite this in a friendlier tone.',
    blockHtml: `<p data-rev="r-ev-c2">${C2_BEFORE}</p>`,
    expectedArchetype: 'content',
    expectedBlockId: 'r-ev-c2',
    expectedDecision: 'addressed',
    expectsEdit: true,
    expectedInnerPattern: (inner) => /password/i.test(inner) && inner.trim() !== C2_BEFORE,
    stubResponse: stub('addressed', 'Softened the wording while keeping the policy intact.', [
      {
        blockId: 'r-ev-c2',
        newInner: 'Please keep your password to yourself &mdash; accounts that share credentials may be suspended.',
      },
    ]),
  }),
  fixture({
    name: 'content-simplify-jargon',
    body: 'Simplify the jargon here so a non-technical reader can follow.',
    blockHtml: '<p data-rev="r-ev-c3">The service leverages idempotent retry semantics to guarantee at-least-once delivery.</p>',
    expectedArchetype: 'content',
    expectedBlockId: 'r-ev-c3',
    expectedDecision: 'addressed',
    expectsEdit: true,
    expectedInnerPattern: (inner) => !/idempotent/i.test(inner) && /retr/i.test(inner),
    stubResponse: stub('addressed', 'Replaced the jargon with a plain-language explanation.', [
      {
        blockId: 'r-ev-c3',
        newInner: 'If a request fails, the service safely retries it until it goes through &mdash; you will never lose a message, though you may occasionally see a duplicate.',
      },
    ]),
  }),
  // ---- section-anchored (WP2: comment on a whole <section>) ------------------
  fixture({
    name: 'section-warm-tone',
    body: 'Rewrite this whole section in a friendlier tone.',
    blockHtml: '<section data-rev="r-ev-w0">'
      + '<h3 data-rev="r-ev-w1">Account termination</h3>'
      + '<p data-rev="r-ev-w2">Accounts in violation will be terminated without notice.</p>'
      + '<p data-rev="r-ev-w3">Reinstatement requests will not be considered.</p>'
      + '</section>',
    expectedArchetype: 'content',
    expectedBlockId: 'r-ev-w0',
    expectedBlockIds: ['r-ev-w1', 'r-ev-w2', 'r-ev-w3'],
    expectedDecision: 'addressed',
    expectsEdit: true,
    expectedInnerPattern: (inner) => /account/i.test(inner) && !/terminated without notice/i.test(inner),
    stubResponse: stub('addressed', 'Softened the whole section.', [
      { blockId: 'r-ev-w1', newInner: 'Keeping your account in good standing' },
      { blockId: 'r-ev-w2', newInner: 'If an account breaks the rules, we may have to close it &mdash; we will always tell you why.' },
      { blockId: 'r-ev-w3', newInner: 'If that ever happens to you, reach out &mdash; we are happy to talk it through.' },
    ]),
  }),
  fixture({
    name: 'section-restructure-list',
    body: 'Restructure the layout of this section: the steps should be a numbered list.',
    blockHtml: '<section data-rev="r-ev-x0">'
      + '<h3 data-rev="r-ev-x1">Getting started</h3>'
      + '<p data-rev="r-ev-x2">First create an account. Then verify your email. Finally install the app.</p>'
      + '</section>',
    expectedArchetype: 'redesign',
    expectedBlockId: 'r-ev-x0',
    expectedBlockIds: ['r-ev-x1', 'r-ev-x2'],
    expectedDecision: 'addressed',
    expectsEdit: true,
    expectedInnerPattern: (inner) => /<ol>/.test(inner) && (inner.match(/<li>/g) ?? []).length >= 3,
    stubResponse: stub('addressed', 'Turned the steps into a numbered list.', [
      {
        blockId: 'r-ev-x2',
        newInner: '<ol><li>Create an account.</li><li>Verify your email.</li><li>Install the app.</li></ol>',
      },
    ]),
  }),

  fixture({
    name: 'content-merge-paragraphs',
    body: 'These two paragraphs say the same thing; condense them into one.',
    blockHtml: '<div data-rev="r-ev-c4"><p>Our support team is available around the clock.</p><p>You can reach our support team at any hour of the day.</p></div>',
    expectedArchetype: 'content',
    expectedBlockId: 'r-ev-c4',
    expectedDecision: 'addressed',
    expectsEdit: true,
    expectedInnerPattern: (inner) => (inner.match(/<p>/g) ?? []).length === 1 && /support/i.test(inner),
    stubResponse: stub('addressed', 'Merged the duplicate paragraphs into one.', [
      { blockId: 'r-ev-c4', newInner: '<p>Our support team is available around the clock.</p>' },
    ]),
  }),
]);
