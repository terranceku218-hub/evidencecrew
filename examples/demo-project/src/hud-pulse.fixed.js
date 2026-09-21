'use strict';

// hud-pulse.js
//
// A damage-flash helper for a health bar. Plain functions only: no classes,
// no timers, no DOM, no dependencies. Every function is pure apart from
// beginPulse (and even there the input state is copied, not mutated).
//
// The pulse is a short accent flash laid over the bar's current colour:
//   phase 0.0 -> the pulse is not running
//   phase 1.0 -> the flash is at full strength
//
// Exports:
//   createHud(color)                      -> initial state
//   beginPulse(state[, options])          -> new state with a pulse running
//   advancePulse(state, deltaSeconds)     -> next state after time passes
//   pulseStyle(state)                     -> { scale, color } for right now

const DEFAULT_OPTIONS = {
  duration: 0.35,
  peakScale: 1.12,
  flashColor: '#ff5a3c'
};

const DEFAULT_COLOR = '#3ec46d';

const HEX6 = /^#[0-9a-fA-F]{6}$/;

// Ease out on the way up and back on the way down: the flash snaps on and
// then fades away. The weight is what blends the baseline colour towards the
// flash accent, so 0 means "plain bar" and 1 means "fully flashed".
function easeOut(t) {
  const clamped = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - clamped, 3);
}

function pulseWeight(phase) {
  if (!Number.isFinite(phase) || phase <= 0 || phase >= 1) {
    return 0;
  }
  return Math.min(easeOut(phase), easeOut(1 - phase));
}

function toRgb(color) {
  if (typeof color !== 'string' || !HEX6.test(color)) {
    return { r: 0, g: 0, b: 0 };
  }
  return {
    r: parseInt(color.slice(1, 3), 16),
    g: parseInt(color.slice(3, 5), 16),
    b: parseInt(color.slice(5, 7), 16)
  };
}

function toHex(r, g, b) {
  const part = (value) => {
    const rounded = Math.min(255, Math.max(0, Math.round(value)));
    return rounded.toString(16).padStart(2, '0');
  };
  return '#' + part(r) + part(g) + part(b);
}

function blend(from, to, weight) {
  const a = toRgb(from);
  const b = toRgb(to);
  const w = Math.min(1, Math.max(0, weight));
  return toHex(
    a.r + (b.r - a.r) * w,
    a.g + (b.g - a.g) * w,
    a.b + (b.b - a.b) * w
  );
}

function createHud(color) {
  return {
    // The bar's resting colour. The colour must always return to the true
    // baseline, never to a mid-flash tint.
    baselineColor: typeof color === 'string' && HEX6.test(color) ? color : DEFAULT_COLOR,
    color: typeof color === 'string' && HEX6.test(color) ? color : DEFAULT_COLOR,
    elapsed: 0,
    active: false,
    duration: DEFAULT_OPTIONS.duration,
    peakScale: DEFAULT_OPTIONS.peakScale,
    flashColor: DEFAULT_OPTIONS.flashColor,
    pulses: 0
  };
}

function beginPulse(state, options) {
  const current = state && typeof state === 'object' ? state : {};
  const opts = options && typeof options === 'object' ? options : {};
  const color = typeof current.color === 'string' && HEX6.test(current.color)
    ? current.color
    : DEFAULT_COLOR;
  const duration = Number.isFinite(opts.duration) && opts.duration > 0
    ? opts.duration
    : (Number.isFinite(current.duration) && current.duration > 0
      ? current.duration
      : DEFAULT_OPTIONS.duration);

  return {
    ...current,
    // The baseline is the bar's resting colour, so it may only be captured
    // while no pulse is running; a pulse that starts mid-flash keeps the
    // baseline it already has.
    baselineColor: current.active === true
      ? (typeof current.baselineColor === 'string' && HEX6.test(current.baselineColor)
        ? current.baselineColor
        : color)
      : color,
    color,
    elapsed: 0,
    active: true,
    duration,
    peakScale: Number.isFinite(opts.peakScale) ? opts.peakScale : current.peakScale,
    flashColor: typeof opts.flashColor === 'string' && HEX6.test(opts.flashColor)
      ? opts.flashColor
      : current.flashColor,
    pulses: (Number.isFinite(current.pulses) ? current.pulses : 0) + 1
  };
}

function advancePulse(state, deltaSeconds) {
  const current = state && typeof state === 'object' ? state : createHud();
  if (!current.active) {
    return { ...current };
  }

  const delta = Number.isFinite(deltaSeconds) && deltaSeconds > 0 ? deltaSeconds : 0;
  const duration = Number.isFinite(current.duration) && current.duration > 0
    ? current.duration
    : DEFAULT_OPTIONS.duration;
  const elapsed = (Number.isFinite(current.elapsed) ? current.elapsed : 0) + delta;
  const progress = Math.min(1, elapsed / duration);
  const active = progress < 1;

  return {
    ...current,
    elapsed: active ? elapsed : duration,
    active,
    color: active
      ? blend(current.baselineColor, current.flashColor, pulseWeight(progress))
      : current.baselineColor
  };
}

function pulseStyle(state) {
  const current = state && typeof state === 'object' ? state : createHud();
  const duration = Number.isFinite(current.duration) && current.duration > 0
    ? current.duration
    : DEFAULT_OPTIONS.duration;
  const elapsed = Number.isFinite(current.elapsed) ? current.elapsed : 0;
  const phase = Math.min(1, Math.max(0, elapsed / duration));
  const peakScale = Number.isFinite(current.peakScale)
    ? current.peakScale
    : DEFAULT_OPTIONS.peakScale;

  if (!current.active) {
    return { scale: 1, color: current.baselineColor };
  }

  const color = typeof current.color === 'string' && HEX6.test(current.color)
    ? current.color
    : (typeof current.baselineColor === 'string' ? current.baselineColor : DEFAULT_COLOR);

  return {
    scale: 1 + (peakScale - 1) * pulseWeight(phase),
    color
  };
}

module.exports = {
  DEFAULT_OPTIONS,
  createHud,
  beginPulse,
  advancePulse,
  pulseStyle
};
