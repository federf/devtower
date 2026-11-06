import assert from 'node:assert/strict';
import test from 'node:test';
import { describeClaudeFailure, parseClaudeResponse } from '../claude-errors.js';

const quota = { type: 'result', subtype: 'success', is_error: true, api_error_status: 429,
  result: "You've hit your session limit · resets 1:50pm (America/Cordoba)", session_id: 'private-session' };

test('usage limit is recognized even with success subtype and exit code zero', () => {
  assert.throws(() => parseClaudeResponse(JSON.stringify(quota)), (error) => {
    assert.equal(error.code, 'claude_usage_limit');
    assert.equal(error.status, 429);
    assert.equal(error.resetAt, '1:50pm (America/Cordoba)');
    assert.match(error.message, /Alcanzaste el límite de uso de Claude/);
    assert.match(error.message, /1:50pm/);
    assert.doesNotMatch(error.message, /session_id|private-session|is_error|api_error_status/);
    return true;
  });
});

test('quota without reset never invents a reset time', () => {
  const error = describeClaudeFailure("You've hit your weekly limit");
  assert.equal(error.resetAt, null);
  assert.match(error.message, /cuando se renueve tu cuota/);
});

test('plain text quota failure has the same treatment', () => {
  assert.throws(() => parseClaudeResponse("You've hit your limit · resets tomorrow", '', 1),
    (error) => error.code === 'claude_usage_limit' && error.resetAt === 'tomorrow');
});

test('temporary rate limit is distinct from account usage quota', () => {
  const error = describeClaudeFailure({ api_error_status: 429, result: 'Too many requests' });
  assert.equal(error.code, 'claude_rate_limit');
  assert.match(error.message, /Esperá unos minutos/);
});

test('missing credits and expired authentication are descriptive', () => {
  assert.equal(describeClaudeFailure('Your credit balance is too low').code, 'claude_insufficient_credits');
  assert.equal(describeClaudeFailure('Not logged in').code, 'claude_auth_required');
});

test('malformed output never exposes raw CLI envelopes or diagnostics', () => {
  for (const stdout of ['{invalid-private-session', 'null', '42', '[]']) {
    assert.throws(() => parseClaudeResponse(stdout, 'private stderr', 1), (error) => {
      assert.equal(error.code, 'claude_request_failed');
      assert.doesNotMatch(error.message, /private|stderr/);
      return true;
    });
  }
});

test('errors in subtype and process exit code are not mistaken for success', () => {
  assert.throws(() => parseClaudeResponse('{"subtype":"error_max_turns","result":"private"}'));
  assert.throws(() => parseClaudeResponse('{"result":"private"}', '', 1));
});

test('timeouts are explicit and successful responses remain unchanged', () => {
  assert.throws(() => parseClaudeResponse('', '', null, true), (error) => error.code === 'claude_timeout');
  assert.deepEqual(parseClaudeResponse('{"result":" Hello ","permission_denials":[]}'), { text: 'Hello', denials: [] });
});
