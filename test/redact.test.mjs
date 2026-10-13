// The pattern-based safety net. All values below are fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactText } from '../scripts/redact.mjs';

const redacts = (input, expected) => assert.equal(redactText(input).text, expected);
const keeps = (input) => assert.deepEqual(redactText(input), { text: input, count: 0 });

test('redacts key-shaped tokens', () => {
  redacts('OPENAI_API_KEY=sk-proj-FAKEfake1234567890abcdef', 'OPENAI_API_KEY=[REDACTED]');
  redacts('token ghp_FAKEaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa here', 'token [REDACTED] here');
  redacts('AKIAFAKEFAKEFAKE1234', '[REDACTED]');
  redacts('Bearer eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4', 'Bearer [REDACTED]');
  redacts('key 0123456789abcdef0123456789abcdef', 'key [REDACTED]');
});

test('redacts labelled values and keeps the label', () => {
  redacts('admin password: Hunter2!', 'admin password: [REDACTED]');
  redacts('**mdp** : azerty123', '**mdp** : [REDACTED]');
  redacts('client_secret = abc-def', 'client_secret = [REDACTED]');
  redacts('RAILS_MASTER_KEY: `abcdef`', 'RAILS_MASTER_KEY: `[REDACTED]`');
  redacts('DB_PASSWORD=s3cret', 'DB_PASSWORD=[REDACTED]');
  redacts('export STRIPE_SECRET_KEY=whatever', 'export STRIPE_SECRET_KEY=[REDACTED]');
});

test('redacts passwords in connection strings and secrets in URL parameters', () => {
  redacts('postgres://app:FakePass99@db.local:5432/x', 'postgres://app:[REDACTED]@db.local:5432/x');
  redacts('https://auth.example/login?session_code=abc123&tab_id=x', 'https://auth.example/login?session_code=[REDACTED]&tab_id=x');
});

test('redacts private key blocks', () => {
  redacts('-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----'.replace(/\n/g, ' '), '[REDACTED]');
});

test('leaves look-alikes alone', () => {
  keeps('# projet secret : Atlas');
  keeps('title: projet secret : Orion');
  keeps('notion_id: 0511a88b0c3d4e5f8a9b0c1d2e3f4a5b');
  keeps('- [Page](https://app.notion.com/p/774830fd0c3d4e5f8a9b0c1d2e3f4a5b)');
  keeps('This page explains the token rotation process.');
  keeps('Le mot de passe est dans 1Password.');
  keeps('Use long passwords and a password manager.');
});

test('is idempotent', () => {
  const once = redactText('password: abc').text;
  assert.deepEqual(redactText(once), { text: once, count: 0 });
});
