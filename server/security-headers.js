/**
 * Valutazione lato server degli header di sicurezza HTTP
 * (header raccolti dall'estensione via webRequest).
 */

export function evaluateSecurityHeaders(headers, url) {
  // headers: oggetto con chiavi lowercase
  const findings = [];
  const isHttps = url.startsWith('https:');
  const add = (severity, header, message) => findings.push({ severity, header, message });

  const csp = headers['content-security-policy'];
  // Wildcard "nuda" (token * isolato), non sottodomini tipo *.example.com
  const cspBareWildcard = !!csp && /default-src[^;]*(?:^|\s)\*(?=\s|;|$)/.test(csp);
  if (!csp) {
    add('warning', 'content-security-policy', 'No Content-Security-Policy header');
  } else {
    if (csp.includes("'unsafe-inline'")) add('warning', 'content-security-policy', "CSP allows 'unsafe-inline'");
    if (csp.includes("'unsafe-eval'")) add('warning', 'content-security-policy', "CSP allows 'unsafe-eval'");
    if (cspBareWildcard) add('warning', 'content-security-policy', 'CSP default-src allows any origin (*)');
  }

  if (isHttps && !headers['strict-transport-security']) {
    add('warning', 'strict-transport-security', 'No Strict-Transport-Security header (HSTS)');
  }

  if (!headers['x-content-type-options'] || headers['x-content-type-options'].toLowerCase() !== 'nosniff') {
    add('warning', 'x-content-type-options', 'X-Content-Type-Options: nosniff missing');
  }

  const hasFrameProtection = headers['x-frame-options'] || (csp && csp.includes('frame-ancestors'));
  if (!hasFrameProtection) {
    add('warning', 'x-frame-options', 'No clickjacking protection (X-Frame-Options or CSP frame-ancestors)');
  }

  if (!headers['referrer-policy']) {
    add('info', 'referrer-policy', 'No Referrer-Policy header');
  }

  if (!headers['permissions-policy']) {
    add('info', 'permissions-policy', 'No Permissions-Policy header');
  }

  const server = headers['server'];
  if (server && /\/[\d.]+/.test(server)) {
    add('info', 'server', `Server header leaks software version: "${server}"`);
  }
  const powered = headers['x-powered-by'];
  if (powered) {
    add('info', 'x-powered-by', `X-Powered-By header leaks stack: "${powered}"`);
  }

  return {
    url,
    findings,
    summary: {
      errors: findings.filter((f) => f.severity === 'error').length,
      warnings: findings.filter((f) => f.severity === 'warning').length,
      info: findings.filter((f) => f.severity === 'info').length,
    },
    grade_hints: {
      csp: !!csp && !csp.includes("'unsafe-inline'") && !csp.includes("'unsafe-eval'") && !cspBareWildcard,
      hsts: !isHttps || !!headers['strict-transport-security'],
      nosniff: headers['x-content-type-options']?.toLowerCase() === 'nosniff',
      clickjacking: !!hasFrameProtection,
    },
  };
}
