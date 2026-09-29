/**
 * Chrome concede 2 captureVisibleTab al secondo per estensione; la terza entro
 * il secondo fallisce con MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND. Invece di
 * far vedere la quota al modello, ogni cattura aspetta il tempo che manca a
 * 520 ms dalla precedente. Orologio e sleep iniettabili per i test.
 */
export function createPacer({ minIntervalMs = 520, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  // Lo slot si prenota prima di dormire: due catture concorrenti leggevano lo
  // stesso "ultimo" e si svegliavano insieme, e la seconda sforava la quota.
  let next = -Infinity;
  const pace = async () => {
    const t = now();
    const slot = Math.max(t, next);
    next = slot + minIntervalMs;
    const wait = slot - t;
    if (wait > 0) await sleep(wait);
    return wait;
  };
  pace.minIntervalMs = minIntervalMs;
  return pace;
}
