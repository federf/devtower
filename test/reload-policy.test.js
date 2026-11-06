import assert from 'node:assert/strict';
import test from 'node:test';
import { hasPendingWork } from '../public/reload-policy.js';

test('idle UI can reload', () => assert.equal(hasPendingWork(), false));
test('running responses block reload', () => assert.equal(hasPendingWork({ tabs: [{ running: true }] }), true));
test('drafts in any tab, attachments and context are protected', () => {
  for (const tab of [{ draft: 'not sent' }, { images: [{}] }, { ctx: [{}] }]) {
    assert.equal(hasPendingWork({ tabs: [{}, tab] }), true);
  }
});
test('composer text is protected before state catches up', () => assert.equal(hasPendingWork({}, { draft: 'draft' }), true));
test('open modals and thread mutations block reload', () => {
  assert.equal(hasPendingWork({}, { modalOpen: true }), true);
  assert.equal(hasPendingWork({ threadMutations: new Set(['id']) }), true);
});
test('unsent Slack replies and pending actions are protected', () => {
  assert.equal(hasPendingWork({ replies: { id: { open: true, text: 'draft' } } }), true);
  assert.equal(hasPendingWork({ replies: { id: { busy: true } } }), true);
});
test('closed reply boxes and whitespace do not block reload', () => {
  assert.equal(hasPendingWork({ tabs: [{ draft: '  ' }], replies: { id: { open: false, text: 'old' } } }), false);
});
