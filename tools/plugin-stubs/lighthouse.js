/**
 * Takes the place of server/lighthouse.js in the bundle of the Claude Code plugin
 * (tools/build-plugin-server.mjs). The real module fetches the Lighthouse CLI from npm
 * on its first call and runs it; the plugin ships no code that fetches and runs another.
 *
 * Nothing is lost: the lighthouse tool works only in launch mode (it needs the DevTools
 * port of the browser chrome-bridge started), and the plugin never starts in launch mode,
 * so the tool already stops at cdpPortOrThrow in server/tools.js with the same message as
 * before, ahead of any call below. The npm package keeps the real module.
 */
const NOT_HERE = 'Lighthouse is not part of the Claude Code plugin: it runs in launch mode, from the npm package chrome-bridge-mcp.';

export function lighthouseVersion() { return null; }
export function lighthouseArgs() { throw new Error(NOT_HERE); }
export function npxCommand() { throw new Error(NOT_HERE); }
export function runLighthouse() { return Promise.reject(new Error(NOT_HERE)); }
export function summarizeLighthouse() { throw new Error(NOT_HERE); }
