// test/runner/overlay-shortcuts.test.mjs — WP3: submit shortcut + off-state.
//
// cmd/ctrl+Enter is the submit gesture in Redline's own textareas; plain
// Enter and other modifier combos must NOT trigger it. isSubmitShortcut() is
// the pure predicate both the comment popover and the reply form use, exposed
// on window.__rvTest. (The review-mode toggle's DOM behavior is Chrome-only;
// its logic — gate the mouseup listener, swap the toolbar label — is covered
// by manual verification and the static extension-ui contract test.)

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOverlay } from './_overlay-load.mjs';


const ev = (props) => ({
  key: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...props,
});

test('cmd+Enter and ctrl+Enter are submit shortcuts', () => {
  const { isSubmitShortcut } = loadOverlay();
  assert.equal(isSubmitShortcut(ev({ key: 'Enter', metaKey: true })), true);
  assert.equal(isSubmitShortcut(ev({ key: 'Enter', ctrlKey: true })), true);
});

test('plain Enter and other keys are not submit shortcuts', () => {
  const { isSubmitShortcut } = loadOverlay();
  assert.equal(isSubmitShortcut(ev({ key: 'Enter' })), false, 'plain Enter stays a newline');
  assert.equal(isSubmitShortcut(ev({ key: 'a', metaKey: true })), false);
  assert.equal(isSubmitShortcut(ev({ key: 'Enter', metaKey: true, shiftKey: true })), false, 'shift excluded');
  assert.equal(isSubmitShortcut(ev({ key: 'Enter', ctrlKey: true, altKey: true })), false, 'alt excluded');
});
