/**
 * Chrome concede 2 captureVisibleTab al secondo per estensione; la terza entro
 * il secondo fallisce con MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND. Invece di
 * far vedere la quota al modello, ogni cattura aspetta il tempo che manca a
 * 520 ms dalla precedente. Orologio e sleep iniettabili per i test.
 */
export function createPacer({ minIntervalMs = 520, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let last = -Infinity;
  const pace = async () => {
    const wait = Math.max(0, last + minIntervalMs - now());
    if (wait > 0) await sleep(wait);
    last = now();
    return wait;
  };
  pace.minIntervalMs = minIntervalMs;
  return pace;
}
