/**
 * Un flusso registrato con session_record (jsonl di comandi) diventa un test
 * Playwright che gira in CI senza bridge né estensione. I comandi che
 * Playwright non ha (handoff, dismiss_overlays…) restano come commento o
 * `page.pause()`: il file dice cosa manca invece di far finta.
 *
 * Lo stato loggato del browser reale NON viene esportato: la testata del file
 * lo dice e rimanda a storageState.
 */

const q = (s) => JSON.stringify(String(s ?? ''));

function fields(list = []) {
  return list.map((f) => `  await page.locator(${q(f.selector)}).fill(${q(f.value)});`);
}

function assertLines(p = {}) {
  const out = [];
  if (p.url) out.push(`  await expect(page).toHaveURL(${p.url.startsWith('/') && p.url.endsWith('/') ? p.url : `/${escapeRe(p.url)}/`});`);
  if (p.title) out.push(`  await expect(page).toHaveTitle(/${escapeRe(p.title)}/);`);
  if (p.selector && p.count != null) out.push(`  await expect(page.locator(${q(p.selector)})).toHaveCount(${Number(p.count)});`);
  else if (p.selector && p.text) out.push(`  await expect(page.locator(${q(p.selector)})).toContainText(${q(p.text)});`);
  else if (p.selector) out.push(`  await expect(page.locator(${q(p.selector)})).${p.state === 'visible' ? 'toBeVisible' : 'toBeAttached'}();`);
  else if (p.text) out.push(`  await expect(page.getByText(${q(p.text)}).first()).toBeVisible();`);
  if (!out.length) out.push(`  // assert with no checkable condition: ${JSON.stringify(p)}`);
  return out;
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'); }

const STEP = {
  navigate: (p) => [`  await page.goto(${q(p.url)});`],
  click: (p) => [`  await page.locator(${q(p.selector)}).click(${p.button === 'right' ? "{ button: 'right' }" : p.count === 2 ? '{ clickCount: 2 }' : ''});`],
  hover: (p) => [`  await page.locator(${q(p.selector)}).hover();`],
  type_text: (p) => [p.mode === 'keys'
    ? `  await page.locator(${q(p.selector)}).pressSequentially(${q(p.text)});`
    : `  await page.locator(${q(p.selector)}).fill(${q(p.text)});`],
  fill_form: (p) => [...fields(p.fields), ...(p.submit_selector ? [`  await page.locator(${q(p.submit_selector)}).click();`] : [])],
  press_key: (p) => [p.selector ? `  await page.locator(${q(p.selector)}).press(${q(p.key)});` : `  await page.keyboard.press(${q(p.key)});`],
  scroll_to: (p) => [p.selector ? `  await page.locator(${q(p.selector)}).scrollIntoViewIfNeeded();` : `  await page.mouse.wheel(${Number(p.x) || 0}, ${Number(p.y) || 0});`],
  wait_for_element: (p) => [`  await page.locator(${q(p.selector)}).waitFor({ timeout: ${Number(p.timeout) || 10000} });`],
  wait_for_text: (p) => [`  await expect(page.getByText(${q(p.text)}).first()).toBeVisible({ timeout: ${Number(p.timeout) || 10000} });`],
  wait_for_navigation: () => ["  await page.waitForLoadState('load');"],
  wait_for_network_idle: () => ["  await page.waitForLoadState('networkidle');"],
  assert: (p) => assertLines(p),
  upload_file: (p) => [`  await page.locator(${q(p.selector)}).setInputFiles(${q(p.name || 'FILE')}); // put the file next to the test`],
  select_option: (p) => [`  await page.locator(${q(p.selector)}).selectOption(${q(p.value)});`],
  handoff: (p) => [`  // HUMAN STEP in the recording: ${p.message}`, '  await page.pause();'],
  dismiss_overlays: () => ['  // dismiss_overlays: close cookie banners here if the test needs it'],
  screenshot: () => ["  await page.screenshot({ path: 'step.png' });"],
};

/** @param {Array<{command:string, params:object}>} steps */
export function toPlaywrightTest(steps, { name = 'recorded flow' } = {}) {
  const body = [];
  const skipped = [];
  for (const { command, params = {} } of steps) {
    const gen = STEP[command];
    if (!gen) { skipped.push(command); body.push(`  // ${command} has no Playwright equivalent: ${JSON.stringify(params).slice(0, 120)}`); continue; }
    body.push(...gen(params));
  }
  const vars = new Set();
  for (const line of body) for (const m of line.matchAll(/\{\{(\w+)\}\}/g)) vars.add(m[1]);
  const head = [
    "import { test, expect } from '@playwright/test';",
    '',
    '// Exported by chrome-bridge from a session recorded in the user\'s real, logged-in Chrome.',
    '// The login state is NOT in this file: reuse it with test.use({ storageState: \'auth.json\' })',
    '// or add the login steps. Selectors are the ones the recording used; tighten them if they drift.',
    ...(vars.size ? [`// Variables from the recording: ${[...vars].join(', ')} — replace {{name}} or read process.env.`] : []),
    '',
    `test(${q(name)}, async ({ page }) => {`,
  ];
  return { source: [...head, ...body, '});', ''].join('\n'), steps: steps.length, skipped };
}
