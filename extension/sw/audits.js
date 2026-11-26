/**
 * I comandi degli audit (server/audit.js): keyboard_walk, list_assets, resource_timing, accessibility_audit, collect_links, seo_audit, unused_css.
 * Parte di service-worker.js, che lo importa: vedi la nota in testa a quel file.
 */
import { resolveTabId } from './tab-target.js';

// --- keyboard_walk ---
// Ordine di tabulazione calcolato (tabindex>0 crescente, poi ordine DOM) e
// focus programmatico elemento per elemento. NON sono veri tasti Tab: un
// focus trap che ascolta keydown non viene esercitato, e lo si dichiara.

export async function cmdKeyboardWalk({ max_steps = 60, start_selector, tab_id }) {
  const tabId = await resolveTabId(tab_id);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (maxSteps, startSel) => {
      const FOCUSABLE = 'a[href],area[href],button,input,select,textarea,iframe,summary,[tabindex],[contenteditable=""],[contenteditable="true"]';
      const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
      const candidates = [...document.querySelectorAll(FOCUSABLE)].filter((el) => !el.disabled && el.tabIndex >= 0 && !el.closest('[inert]') && el.type !== 'hidden' && visible(el));
      const order = [...candidates.filter((e) => e.tabIndex > 0).sort((a, b) => a.tabIndex - b.tabIndex), ...candidates.filter((e) => e.tabIndex === 0)];
      const dialog = document.querySelector('[role="dialog"][aria-modal="true"], dialog[open]');
      const selectorOf = (el) => {
        if (el.id) return `#${CSS.escape(el.id)}`;
        const tag = el.tagName.toLowerCase();
        const name = el.getAttribute('name');
        if (name) return `${tag}[name="${name}"]`;
        const cls = [...el.classList].slice(0, 2).map((c) => `.${CSS.escape(c)}`).join('');
        const p = el.parentElement;
        const idx = p ? [...p.children].filter((c) => c.tagName === el.tagName).indexOf(el) + 1 : 1;
        return `${tag}${cls}:nth-of-type(${idx})`;
      };
      let start = 0;
      if (startSel) { const i = order.indexOf(document.querySelector(startSel)); if (i >= 0) start = i; }
      const prev = document.activeElement;
      const steps = []; const issues = {};
      for (let i = start; i < order.length && steps.length < maxSteps; i++) {
        const el = order[i];
        el.focus();
        const got = document.activeElement === el;
        const r = el.getBoundingClientRect();
        const inView = r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
        let fv = false; try { fv = el.matches(':focus-visible'); } catch { /* vecchio Chrome */ }
        const cs = getComputedStyle(el);
        const indicator = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== 'none';
        let issue = null;
        if (!got) issue = 'focus refused';
        else if (!inView) issue = 'focused but off-screen';
        else if (fv && !indicator) issue = 'no visible focus indicator';
        else if (dialog && !dialog.contains(el)) issue = 'outside the open dialog (focus not trapped)';
        if (issue) issues[issue] = (issues[issue] || 0) + 1;
        const text = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 40);
        steps.push({ step: steps.length + 1, selector: selectorOf(el), tag: el.tagName.toLowerCase(), text, tabindex: el.tabIndex, focus_visible: fv, issue });
      }
      if (prev && prev.focus) prev.focus(); else if (document.activeElement?.blur) document.activeElement.blur();
      return { total_focusable: order.length, walked: steps.length, dialog_open: !!dialog, positive_tabindex: candidates.filter((e) => e.tabIndex > 0).length, steps, issues };
    },
    args: [max_steps, start_selector ?? null],
  });
  return results?.[0]?.result ?? { error: 'no result' };
}

// --- list_assets ---

export async function cmdListAssets({ max_per_kind = 8, tab_id }) {
  const tabId = await resolveTabId(tab_id);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (max) => {
      const abs = (u) => { try { return new URL(u, location.href).href; } catch { return null; } };
      const take = (sel, attr) => [...document.querySelectorAll(sel)].map((e) => abs(e.getAttribute(attr))).filter((u) => u && /^https?:/.test(u)).filter((u, i, a) => a.indexOf(u) === i).slice(0, max);
      return { page: location.href, stylesheets: take('link[rel~="stylesheet"][href]', 'href'), scripts: take('script[src]', 'src'), images: take('img[src]', 'src') };
    },
    args: [max_per_kind],
  });
  return results?.[0]?.result ?? { page: null, stylesheets: [], scripts: [], images: [] };
}

// --- resource_timing ---

export async function cmdResourceTiming({ limit = 500, tab_id }) {
  const tabId = await resolveTabId(tab_id);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (max) => {
      const nav = performance.getEntriesByType('navigation')[0];
      const entries = performance.getEntriesByType('resource').slice(0, max).map((e) => ({
        name: e.name, type: e.initiatorType, start: Math.round(e.startTime), duration: Math.round(e.duration),
        transfer: e.transferSize || 0, size: e.encodedBodySize || 0, blocking: e.renderBlockingStatus || '',
      }));
      return {
        page: location.href, host: location.hostname, entries,
        navigation: nav ? { dom_content_loaded: Math.round(nav.domContentLoadedEventEnd), load: Math.round(nav.loadEventEnd), ttfb: Math.round(nav.responseStart) } : null,
      };
    },
    args: [limit],
  });
  return results?.[0]?.result ?? { entries: [] };
}

// --- accessibility_audit ---

export async function cmdAccessibilityAudit({ scope, checks = ['all'], tab_id }) {
  const tabId = await resolveTabId(tab_id);

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (scopeSel, checkList) => {
      const root = scopeSel ? document.querySelector(scopeSel) : document.body;
      if (!root) return { summary: { total: 0, errors: 0, warnings: 0 }, violations: [], warning: 'Scope element not found' };

      const runAll = checkList.includes('all');
      const violations = [];
      const CAP = 500;

      function selectorFor(el) {
        if (el.id) return `#${el.id}`;
        const tag = el.tagName.toLowerCase();
        const cls = el.className ? `.${el.className.toString().trim().split(/\s+/).join('.')}` : '';
        return `${tag}${cls}`;
      }

      // Images
      if (runAll || checkList.includes('images')) {
        const imgs = [...root.querySelectorAll('img')].slice(0, CAP);
        for (const img of imgs) {
          // img.alt è '' sia per attributo mancante che vuoto: serve hasAttribute
          if (!img.hasAttribute('alt')) {
            violations.push({ type: 'images', severity: 'error', selector: selectorFor(img), message: 'Image missing alt attribute' });
          } else if (img.alt === '') {
            violations.push({ type: 'images', severity: 'warning', selector: selectorFor(img), message: 'Image has empty alt (decorative?)' });
          }
        }
        const svgs = [...root.querySelectorAll('svg')].slice(0, CAP);
        for (const svg of svgs) {
          if (!svg.getAttribute('aria-label') && !svg.getAttribute('aria-labelledby') && !svg.querySelector('title')) {
            violations.push({ type: 'images', severity: 'warning', selector: selectorFor(svg), message: 'SVG missing accessible name' });
          }
        }
      }

      // Links
      if (runAll || checkList.includes('links')) {
        const links = [...root.querySelectorAll('a')].slice(0, CAP);
        for (const a of links) {
          const text = a.textContent.trim();
          const label = a.getAttribute('aria-label');
          if (!text && !label && !a.querySelector('img[alt]')) {
            violations.push({ type: 'links', severity: 'error', selector: selectorFor(a), message: 'Empty link without accessible name' });
          }
        }
      }

      // Headings
      if (runAll || checkList.includes('headings')) {
        const headings = [...root.querySelectorAll('h1,h2,h3,h4,h5,h6')];
        let prevLevel = 0;
        for (const h of headings) {
          const level = parseInt(h.tagName[1]);
          if (prevLevel > 0 && level > prevLevel + 1) {
            violations.push({ type: 'headings', severity: 'warning', selector: selectorFor(h), message: `Heading skip: h${prevLevel} → h${level}` });
          }
          prevLevel = level;
        }
      }

      // ARIA
      if (runAll || checkList.includes('aria')) {
        const ariaHidden = [...root.querySelectorAll('[aria-hidden="true"]')].slice(0, CAP);
        for (const el of ariaHidden) {
          if (el.matches('a[href], button, input, select, textarea, [tabindex]') || el.querySelector('a[href], button, input, select, textarea, [tabindex]')) {
            violations.push({ type: 'aria', severity: 'error', selector: selectorFor(el), message: 'aria-hidden on focusable element' });
          }
        }
      }

      // Contrast (WCAG 2.1 ratio)
      if (runAll || checkList.includes('contrast')) {
        const parseColor = (c) => {
          const m = c.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
          if (!m) return null;
          return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
        };
        const luminance = ({ r, g, b }) => {
          const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
          return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
        };
        const effectiveBg = (el) => {
          let node = el;
          while (node && node !== document.documentElement) {
            const bg = parseColor(getComputedStyle(node).backgroundColor);
            if (bg && bg.a >= 0.99) return bg;
            node = node.parentElement;
          }
          return { r: 255, g: 255, b: 255, a: 1 };
        };
        const textEls = [...root.querySelectorAll('p, span, a, li, td, th, label, h1, h2, h3, h4, h5, h6, button')].slice(0, 200);
        for (const el of textEls) {
          if (!el.textContent.trim()) continue;
          const style = getComputedStyle(el);
          const fg = parseColor(style.color);
          if (!fg) continue;
          const bg = effectiveBg(el);
          const L1 = Math.max(luminance(fg), luminance(bg));
          const L2 = Math.min(luminance(fg), luminance(bg));
          const ratio = (L1 + 0.05) / (L2 + 0.05);
          const px = parseFloat(style.fontSize);
          const bold = parseInt(style.fontWeight) >= 700;
          const isLarge = px >= 24 || (px >= 18.66 && bold);
          const required = isLarge ? 3 : 4.5;
          if (ratio < required) {
            violations.push({
              type: 'contrast',
              severity: ratio < required - 1.5 ? 'error' : 'warning',
              selector: selectorFor(el),
              message: `Contrast ${ratio.toFixed(2)}:1 below WCAG ${required}:1 (${isLarge ? 'large' : 'normal'} text)`,
            });
          }
        }
      }

      // Forms
      if (runAll || checkList.includes('forms')) {
        const inputs = [...root.querySelectorAll('input, select, textarea')].slice(0, CAP);
        for (const input of inputs) {
          if (input.type === 'hidden' || input.type === 'submit' || input.type === 'button') continue;
          const id = input.id;
          const hasLabel = id && root.querySelector(`label[for="${id}"]`);
          const wrappedLabel = input.closest('label');
          const ariaLabel = input.getAttribute('aria-label') || input.getAttribute('aria-labelledby');
          if (!hasLabel && !wrappedLabel && !ariaLabel) {
            violations.push({ type: 'forms', severity: 'error', selector: selectorFor(input), message: 'Form input without associated label' });
          }
        }
      }

      const errors = violations.filter((v) => v.severity === 'error').length;
      const warnings = violations.filter((v) => v.severity === 'warning').length;
      return { summary: { total: violations.length, errors, warnings }, violations };
    },
    args: [scope || null, checks],
    world: 'MAIN',
  });
  return results?.[0]?.result ?? { summary: { total: 0, errors: 0, warnings: 0 }, violations: [] };
}

// --- collect_links ---

export async function cmdCollectLinks({ scope = 'all', selector = 'a[href]', max_links = 50, tab_id }) {
  const tabId = await resolveTabId(tab_id);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel, linkScope, maxLinks) => {
      const origin = location.origin;
      const skipPatterns = /^(javascript:|mailto:|tel:|#|data:)/i;
      const anchors = [...document.querySelectorAll(sel)].slice(0, 500);
      const seen = new Set();
      const links = [];
      for (const a of anchors) {
        const href = a.href;
        if (!href || skipPatterns.test(href) || seen.has(href)) continue;
        seen.add(href);
        try {
          const url = new URL(href);
          const isSameOrigin = url.origin === origin;
          if (linkScope === 'same-origin' && !isSameOrigin) continue;
          if (linkScope === 'external' && isSameOrigin) continue;
          links.push({ url: href, text: a.textContent.trim().substring(0, 100) });
        } catch { continue; }
        if (links.length >= maxLinks) break;
      }
      return { links, totalAnchors: anchors.length };
    },
    args: [selector, scope, max_links],
    world: 'MAIN',
  });
  return results?.[0]?.result ?? { links: [], totalAnchors: 0 };
}

// --- seo_audit ---

export async function cmdSeoAudit({ tab_id }) {
  const tabId = await resolveTabId(tab_id);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const findings = [];
      const add = (type, severity, message, value) => {
        const f = { type, severity, message };
        if (value !== undefined) f.value = value;
        findings.push(f);
      };

      // Title
      const title = (document.title || '').trim();
      if (!title) add('title', 'error', 'Missing <title>');
      else if (title.length < 15) add('title', 'warning', 'Title too short', title.length);
      else if (title.length > 60) add('title', 'warning', 'Title too long', title.length);

      // Meta description
      const descEl = document.querySelector('meta[name="description"]');
      const desc = descEl ? (descEl.getAttribute('content') || '').trim() : '';
      if (!desc) add('meta_description', 'error', 'Missing meta description');
      else if (desc.length < 50) add('meta_description', 'warning', 'Meta description too short', desc.length);
      else if (desc.length > 160) add('meta_description', 'warning', 'Meta description too long', desc.length);

      // Canonical
      const canonical = document.querySelector('link[rel="canonical"]');
      if (!canonical) {
        add('canonical', 'warning', 'Missing canonical link');
      } else {
        add('canonical', 'info', 'Canonical present', canonical.href);
        const stripHash = (u) => u.split('#')[0];
        if (canonical.href && stripHash(canonical.href) !== stripHash(location.href)) {
          add('canonical', 'info', 'Canonical differs from current URL', canonical.href);
        }
      }

      // Robots meta
      const robots = document.querySelector('meta[name="robots"]');
      if (!robots) {
        add('robots', 'info', 'No robots meta (default: index,follow)');
      } else {
        const content = robots.getAttribute('content') || '';
        if (content.toLowerCase().includes('noindex')) add('robots', 'warning', 'Page is noindex', content);
      }

      // h1 count
      const h1Count = document.querySelectorAll('h1').length;
      if (h1Count === 0) add('h1', 'error', 'No h1 on page');
      else if (h1Count > 1) add('h1', 'warning', 'Multiple h1 elements', h1Count);

      // Open Graph
      for (const prop of ['og:title', 'og:description', 'og:image']) {
        if (!document.querySelector(`meta[property="${prop}"]`)) {
          add('open_graph', 'warning', `Missing ${prop}`);
        }
      }

      // Twitter card
      if (!document.querySelector('meta[name="twitter:card"]')) {
        add('twitter_card', 'info', 'Missing twitter:card meta');
      }

      // JSON-LD
      const ldScripts = [...document.querySelectorAll('script[type="application/ld+json"]')];
      ldScripts.forEach((script, i) => {
        try {
          const data = JSON.parse(script.textContent);
          const types = [];
          const collect = (node) => {
            if (!node || typeof node !== 'object') return;
            if (Array.isArray(node)) { node.forEach(collect); return; }
            if (node['@type']) types.push(...[].concat(node['@type']));
            if (node['@graph']) collect(node['@graph']);
          };
          collect(data);
          add('json_ld', 'info', `JSON-LD block ${i + 1}/${ldScripts.length} is valid`, types.length ? types.join(', ') : 'no @type');
        } catch (e) {
          add('json_ld', 'error', `JSON-LD block ${i + 1}/${ldScripts.length} parse error: ${e.message}`);
        }
      });

      // hreflang
      const hreflangCount = document.querySelectorAll('link[rel="alternate"][hreflang]').length;
      if (hreflangCount > 0) add('hreflang', 'info', 'hreflang alternates present', hreflangCount);

      // lang attribute
      if (!document.documentElement.getAttribute('lang')) {
        add('lang', 'warning', 'Missing lang attribute on <html>');
      }

      // Viewport meta
      if (!document.querySelector('meta[name="viewport"]')) {
        add('viewport', 'error', 'No viewport meta (not mobile-friendly)');
      }

      // Favicon
      if (!document.querySelector('link[rel*="icon"]')) {
        add('favicon', 'info', 'No favicon link found');
      }

      // Images without alt
      const noAltCount = [...document.querySelectorAll('img')].filter((img) => !img.hasAttribute('alt')).length;
      if (noAltCount > 0) {
        add('images', 'warning', `${noAltCount} images without alt attribute (accessibility_audit has details)`, noAltCount);
      }

      const errors = findings.filter((f) => f.severity === 'error').length;
      const warnings = findings.filter((f) => f.severity === 'warning').length;
      const info = findings.filter((f) => f.severity === 'info').length;
      return {
        summary: { errors, warnings, info },
        findings,
        page: { title, url: location.href },
      };
    },
    world: 'MAIN',
  });
  return results?.[0]?.result ?? { summary: { errors: 0, warnings: 0, info: 0 }, findings: [], page: {} };
}

// --- unused_css ---

export async function cmdUnusedCss({ max_selectors = 200, tab_id }) {
  const tabId = await resolveTabId(tab_id);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (maxSelectors) => {
      const sheets = [];
      const unusedSelectors = [];
      let totalUnused = 0;
      let totalChecked = 0;
      let totalSkipped = 0;

      for (const sheet of document.styleSheets) {
        const sheetInfo = { href: sheet.href || 'inline', accessible: true, total_rules: 0, unused_count: 0 };
        let rules;
        try {
          rules = sheet.cssRules;
        } catch {
          sheetInfo.accessible = false;
          sheets.push(sheetInfo);
          continue;
        }

        // Flatten media/supports rules one level
        const styleRules = [];
        for (const rule of rules) {
          if (rule instanceof CSSStyleRule) {
            styleRules.push(rule);
          } else if ((rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule) && rule.cssRules) {
            for (const inner of rule.cssRules) {
              if (inner instanceof CSSStyleRule) styleRules.push(inner);
            }
          }
        }
        sheetInfo.total_rules = styleRules.length;

        for (const rule of styleRules) {
          const selectors = (rule.selectorText || '').split(',');
          for (const rawSel of selectors) {
            const cleaned = rawSel.replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, '').trim();
            if (!cleaned || /^[>+~\s]*$/.test(cleaned)) continue;
            totalChecked++;
            let matched;
            try {
              matched = document.querySelector(cleaned) !== null;
            } catch {
              totalSkipped++;
              continue;
            }
            if (!matched) {
              totalUnused++;
              sheetInfo.unused_count++;
              if (unusedSelectors.length < maxSelectors) unusedSelectors.push(rawSel.trim());
            }
          }
        }
        sheets.push(sheetInfo);
      }

      return {
        sheets,
        unused_selectors: unusedSelectors,
        total_unused: totalUnused,
        total_checked: totalChecked,
        skipped: totalSkipped,
        note: 'Approximate: only current DOM state; dynamic/JS-toggled selectors may be falsely reported',
      };
    },
    args: [max_selectors],
    world: 'MAIN',
  });
  return results?.[0]?.result ?? { sheets: [], unused_selectors: [], total_unused: 0, total_checked: 0 };
}
