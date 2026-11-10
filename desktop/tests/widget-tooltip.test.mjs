import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';

const source = fs.readFileSync(fileURLToPath(new URL('../ui/widget.mjs', import.meta.url)), 'utf8');
const css = fs.readFileSync(fileURLToPath(new URL('../ui/widget.css', import.meta.url)), 'utf8');

test('quota details are drawn in-widget instead of using a native title tooltip', () => {
  // A native tip is painted by Windows and stays while the pointer rests, which
  // is exactly the bug being fixed; the widget must not set one for the bubble.
  assert.match(source, /function showTooltip\(/);
  assert.match(source, /function hideTooltip\(/);
  assert.match(source, /function updateTooltip\(/);
  const applier = source.slice(source.indexOf('function applyBubbleTooltips'), source.indexOf('function bubbleTransition'));
  assert.ok(!/bubble\.title\s*=/.test(applier), 'bubble must not receive a native title');
  assert.ok(!/\$\("header"\)\.title\s*=/.test(applier), 'header must not receive a native title');
  assert.ok(!/quote\.title\s*=/.test(applier), 'quote must not receive a native title');
});

test('the pointer leaving the hovered element dismisses the tip immediately', () => {
  // Hide must happen on the same pointermove that reports a different target,
  // with no timer: that is the "moves away, disappears at once" behaviour.
  assert.match(source, /const hovered = hitUpdate\(event\);\s*\n\s*updateTooltip\(hovered\);/);
  assert.match(source, /document\.addEventListener\("pointerleave", \(\) => hideTooltip\(\)\)/);
  assert.match(source, /document\.addEventListener\("blur", \(\) => hideTooltip\(\)\)/);
  const update = source.slice(source.indexOf('function updateTooltip'), source.indexOf('function bubbleTransition'));
  assert.match(update, /hideTooltip\(\)/);
  assert.ok(!/setTimeout/.test(update), 'hiding must not be deferred');
});

test('a collapsed bubble never keeps a tip visible', () => {
  const clear = source.slice(source.indexOf('function clearBubbleTooltips'), source.indexOf('function applyBubbleTooltips'));
  assert.match(clear, /hideTooltip\(\)/);
  const transition = source.slice(source.indexOf('function bubbleTransition'), source.indexOf('function installImage'));
  assert.match(transition, /if \(!open\) clearBubbleTooltips\(\);/);
});

test('the tooltip is clamped inside the window and ignores the pointer', () => {
  // Fixed, not absolute: #stage is scale-transformed, so an absolutely placed tip
  // had its viewport coordinates multiplied and was clipped by the stage box.
  assert.match(css, /#widget-tooltip\s*\{[^}]*position:\s*fixed/);
  assert.match(css, /#widget-tooltip\s*\{[^}]*pointer-events:\s*none/);
  assert.match(source, /document\.body\.appendChild\(tooltipNode\)/);
  // Placement must clamp both axes so the tip cannot render off-screen.
  assert.match(source, /left = Math\.max\(4, Math\.min\(left, width - box\.width - 4\)\)/);
  assert.match(source, /top = Math\.max\(4, Math\.min\(top, height - box\.height - 4\)\)/);
});

test('quote and completion modes never duplicate the bubble text in a tooltip', () => {
  // The bubble already renders that sentence; a second copy only overlapped and
  // truncated it. Only the quota view has detail worth a tip.
  const update = source.slice(source.indexOf('function updateTooltip'), source.indexOf('function bubbleTransition'));
  assert.ok(!/tooltipText\.quote/.test(update), 'quote mode must not raise a tooltip');
  assert.match(update, /state\.scene\.mode === "quota"/);
});

test('empty tooltip text removes the node instead of showing an empty box', () => {
  const show = source.slice(source.indexOf('function showTooltip'), source.indexOf('// Called on every pointer move'));
  assert.match(show, /if \(!value \|\| !anchorElement\) \{ hideTooltip\(\); return; \}/);
  assert.match(show, /tooltipNode\.textContent = value;/);
});
