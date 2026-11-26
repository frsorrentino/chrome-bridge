/**
 * emulate_media via chrome.debugger: dalle opzioni del tool ai comandi CDP.
 *
 * Con il debugger l'emulazione è quella di DevTools: le regole
 * @media (prefers-reduced-motion) dei fogli del sito valgono davvero, mentre
 * il ripiego nella pagina cambia solo matchMedia e azzera tutte le durate.
 * CPU, rete, viewport con DPR e touch esistono solo qui.
 *
 * Pura: restituisce coppie [metodo, parametri], così i test la provano senza
 * browser. Il service worker le manda in ordine sulla scheda tenuta.
 */

// Profili di rete di DevTools (Chrome 154): latenza in ms, banda in byte/s,
// già scalate come le applica DevTools.
export const NETWORK_PROFILES = {
  offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
  '3g': { offline: false, latency: 2000, downloadThroughput: 45000, uploadThroughput: 45000 },
  'slow-4g': { offline: false, latency: 562.5, downloadThroughput: 180000, uploadThroughput: 84375 },
  'fast-4g': { offline: false, latency: 165, downloadThroughput: 1012500, uploadThroughput: 168750 },
  none: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
};

/**
 * @param {object} o - colorScheme, reducedMotion, contrast, printMode,
 *   cpu_throttle, network, device {width,height,dpr,mobile}, touch
 * @returns {{ commands: Array<[string, object]>, emulated: object }}
 */
export function emulationCommands(o = {}) {
  const commands = [];
  const emulated = {};
  const features = [];
  if (o.colorScheme) { features.push({ name: 'prefers-color-scheme', value: o.colorScheme }); emulated.colorScheme = o.colorScheme; }
  if (o.reducedMotion) { features.push({ name: 'prefers-reduced-motion', value: o.reducedMotion }); emulated.reducedMotion = o.reducedMotion; }
  if (o.contrast) { features.push({ name: 'prefers-contrast', value: o.contrast }); emulated.contrast = o.contrast; }
  if (features.length || o.printMode) {
    commands.push(['Emulation.setEmulatedMedia', { media: o.printMode ? 'print' : '', features }]);
    if (o.printMode) emulated.printMode = true;
  }
  if (o.cpu_throttle != null) {
    const rate = Math.max(1, Number(o.cpu_throttle));
    commands.push(['Emulation.setCPUThrottlingRate', { rate }]);
    emulated.cpu_throttle = rate;
  }
  if (o.network) {
    const p = NETWORK_PROFILES[o.network];
    if (!p) throw new Error(`Unknown network profile ${o.network}: use ${Object.keys(NETWORK_PROFILES).join(', ')}`);
    commands.push(['Network.emulateNetworkConditions', p]);
    emulated.network = o.network;
  }
  if (o.device) {
    const { width, height, dpr = 1, mobile = false } = o.device;
    if (!(width > 0 && height > 0)) throw new Error('device needs width and height in CSS px');
    commands.push(['Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile }]);
    emulated.device = { width, height, dpr, mobile };
  }
  if (o.touch != null) {
    commands.push(['Emulation.setTouchEmulationEnabled', { enabled: Boolean(o.touch), ...(o.touch && { maxTouchPoints: 5 }) }]);
    emulated.touch = Boolean(o.touch);
  }
  return { commands, emulated };
}
