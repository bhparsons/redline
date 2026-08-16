// test/runner/comment-thread.test.mjs — #108: the prompt must show the agent
// its own prior turns.
//
// The live failure: comment c-367fc6245920 asked for electric pink, the agent
// declined on legibility, Blake replied "ok let's try forest green instead",
// and the re-run declined AGAIN — reading the reply as a retraction because
// the prompt carried ask → reply with no decision in between. The thread is
// only a conversation if the agent's turns are in it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { commentThread } from '../../runner/lib/api.mjs';

const COMMENT = {
  id: 'c-1',
  body: 'change all body text to electric pink',
  createdAt: '2026-07-24T05:00:00.000Z',
  replies: [{ id: 'rp-1', body: "ok let's try forest green instead", createdAt: '2026-07-24T05:28:54.262Z' }],
};

const DECLINE_RUN = {
  runId: 'run-1',
  commentId: 'c-1',
  status: 'ok',
  createdAt: '2026-07-24T05:10:00.000Z',
  decisions: [{
    id: 'c-1',
    decision: 'declined',
    summary: 'Declined a page-wide text-colour change to electric pink as it would harm readability.',
    note: 'Legibility concern.',
  }],
};

test('the agent’s prior decision lands between the ask and the reply', () => {
  const { thread, latestAsk } = commentThread(COMMENT, [DECLINE_RUN]);
  assert.deepEqual(thread.map((e) => `${e.role}:${e.kind}`),
    ['reviewer:ask', 'agent:decision', 'reviewer:reply']);
  assert.equal(thread[1].decision, 'declined');
  assert.match(thread[1].summary, /readability/);
  // The reply is the last thing the AUTHOR said, so it is the operative ask.
  assert.equal(latestAsk, "ok let's try forest green instead");
});

test('latestAsk falls back to the original body when there are no replies', () => {
  const { thread, latestAsk } = commentThread({ ...COMMENT, replies: [] }, [DECLINE_RUN]);
  assert.equal(latestAsk, 'change all body text to electric pink');
  assert.deepEqual(thread.map((e) => e.kind), ['ask', 'decision']);
});

test('only decisions for THIS comment are included', () => {
  const other = { ...DECLINE_RUN, runId: 'run-2', commentId: 'c-2', decisions: [{ id: 'c-2', decision: 'addressed', summary: 'other comment' }] };
  const { thread } = commentThread(COMMENT, [DECLINE_RUN, other]);
  assert.equal(thread.filter((e) => e.kind === 'decision').length, 1);
  assert.ok(!JSON.stringify(thread).includes('other comment'));
});

test('batch runs contribute their decision for this comment', () => {
  const batch = {
    runId: 'run-3',
    commentIds: ['c-0', 'c-1'],
    createdAt: '2026-07-24T05:05:00.000Z',
    decisions: [
      { id: 'c-0', decision: 'addressed', summary: 'someone else' },
      { id: 'c-1', decision: 'deferred', summary: 'needs a wider change' },
    ],
  };
  const { thread } = commentThread(COMMENT, [batch]);
  const decisions = thread.filter((e) => e.kind === 'decision');
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].decision, 'deferred');
});

test('an undone run’s decision is marked undone', () => {
  const { thread } = commentThread(COMMENT, [{ ...DECLINE_RUN, status: 'undone' }]);
  assert.equal(thread.find((e) => e.kind === 'decision').undone, true);
});

test('agent-authored replies are attributed to the agent, not the reviewer', () => {
  const withAgentReply = {
    ...COMMENT,
    replies: [
      { id: 'rp-a', body: 'agent note', createdAt: '2026-07-24T05:20:00.000Z', creator: 'agent', agentName: 'claude-fable' },
      { id: 'rp-b', body: 'human follow-up', createdAt: '2026-07-24T05:30:00.000Z' },
    ],
  };
  const { thread, latestAsk } = commentThread(withAgentReply, []);
  const agentReply = thread.find((e) => e.kind === 'reply' && e.role === 'agent');
  assert.equal(agentReply.agentName, 'claude-fable');
  // An agent reply must never be mistaken for the reviewer's operative ask.
  assert.equal(latestAsk, 'human follow-up');
});

test('missing/odd inputs degrade quietly — a thread must never fail a run', () => {
  assert.deepEqual(commentThread({ id: 'c-1', body: 'x' }).thread.map((e) => e.kind), ['ask']);
  assert.equal(commentThread({ id: 'c-1', body: 'x' }, null).latestAsk, 'x');
  assert.equal(commentThread({ id: 'c-1', body: 'x', replies: 'nope' }, [{}]).thread.length, 1);
  assert.equal(commentThread({ id: 'c-1', body: 'x' }, [{ commentId: 'c-1', decisions: 'bad' }]).thread.length, 1);
});
