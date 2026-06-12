/**
 * Conversione delle richieste catturate in formato HAR 1.2.
 */

import { VERSION } from './protocol.js';

export function toHar(requests) {
  return {
    log: {
      version: '1.2',
      creator: { name: 'chrome-bridge', version: VERSION },
      entries: requests.map((r) => ({
        startedDateTime: new Date(r.startTime).toISOString(),
        time: r.duration ?? 0,
        request: { method: r.method || 'GET', url: r.url, httpVersion: '', headers: [], queryString: [], cookies: [], headersSize: -1, bodySize: -1 },
        response: { status: r.status ?? 0, statusText: r.error || '', httpVersion: '', headers: [], cookies: [], content: { size: -1, mimeType: '' }, redirectURL: '', headersSize: -1, bodySize: -1 },
        cache: {},
        timings: { send: 0, wait: r.duration ?? 0, receive: 0 },
      })),
    },
  };
}
