import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const viewportFitModule = await import('../src/viewportFit.js').catch(() => ({}));
const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');

function getRule(selector) {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `${selector} rule must exist`);

  const end = css.indexOf('}', start);
  assert.notEqual(end, -1, `${selector} rule must be closed`);

  return css.slice(start, end + 1).replace(/\s+/g, ' ');
}

test('an oversized panel is uniformly scaled down to fit the viewport', () => {
  assert.equal(typeof viewportFitModule.getViewportFitScale, 'function');

  assert.equal(viewportFitModule.getViewportFitScale({
    viewportWidth: 1200,
    viewportHeight: 800,
    panelWidth: 600,
    panelHeight: 1200,
    inset: 16,
  }), 0.64);

  assert.equal(viewportFitModule.getViewportFitScale({
    viewportWidth: 1200,
    viewportHeight: 800,
    panelWidth: 600,
    panelHeight: 600,
    inset: 16,
  }), 1);
});

test('fitting a panel applies the measured scale as a CSS variable', () => {
  assert.equal(typeof viewportFitModule.fitPanelToViewport, 'function');

  const properties = new Map();
  const panel = {
    offsetWidth: 600,
    offsetHeight: 1200,
    style: {
      setProperty(name, value) {
        properties.set(name, value);
      },
    },
  };
  const viewport = { clientWidth: 1200, clientHeight: 800 };

  assert.equal(viewportFitModule.fitPanelToViewport(panel, viewport), 0.64);
  assert.equal(properties.get('--viewport-fit-scale'), '0.64');
});

test('the glass panel uses automatic scaling instead of an internal scrollbar', () => {
  const appContainer = getRule('.app-container');
  const glassPanel = getRule('.glass-panel');

  assert.match(appContainer, /height: 100dvh;/);
  assert.match(glassPanel, /transform: scale\(var\(--viewport-fit-scale, 1\)\);/);
  assert.doesNotMatch(glassPanel, /overflow-y:/);
  assert.doesNotMatch(glassPanel, /max-height:/);
});
