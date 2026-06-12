import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSecurityHeaders } from '../../server/security-headers.js';

test('valuta header completi senza findings critici', () => {
  const result = evaluateSecurityHeaders({
    'content-security-policy': "default-src 'self'",
    'strict-transport-security': 'max-age=31536000; includeSubDomains',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy': 'camera=()',
  }, 'https://example.com/');
  assert.equal(result.findings.filter((f) => f.severity === 'error').length, 0);
  assert.equal(result.grade_hints.csp, true);
  assert.equal(result.grade_hints.hsts, true);
});

test('segnala header mancanti e CSP unsafe-inline', () => {
  const result = evaluateSecurityHeaders({
    'content-security-policy': "default-src * 'unsafe-inline' 'unsafe-eval'",
    'server': 'Apache/2.4.41 (Ubuntu)',
  }, 'https://example.com/');
  const messages = result.findings.map((f) => f.message).join(' | ');
  assert.match(messages, /unsafe-inline/);
  assert.match(messages, /unsafe-eval/);
  assert.match(messages, /Strict-Transport-Security/);
  assert.match(messages, /X-Content-Type-Options/);
  assert.match(messages, /version/i); // Server header leak
});

test('http URL: HSTS non applicabile', () => {
  const result = evaluateSecurityHeaders({}, 'http://localhost:3000/');
  const hsts = result.findings.find((f) => f.message.includes('Strict-Transport-Security'));
  assert.equal(hsts, undefined);
});
