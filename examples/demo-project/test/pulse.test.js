'use strict';

// test/pulse.test.js
//
// Zero-dependency test runner for src/hud-pulse.js.
//
//   node test/pulse.test.js
//
// Prints one line per check, then a summary line, and exits non-zero when
// any check failed.

const assert = require('assert');

const {
  createHud,
  beginPulse,
  advancePulse,
  pulseStyle
} = require('../src/hud-pulse.js');

const checks = [];

function check(name, condition, detail) {
  checks.push({ name, passed: Boolean(condition), detail });
}

function detailOf(error) {
  return error && error.message ? error.message.split('\n')[0] : String(error);
}

function channel(color, index) {
  return parseInt(color.slice(1 + index * 2, 3 + index * 2), 16);
}

const HEAL_GREEN = '#3ec46d';
const FLASH_ACCENT = '#ff5a3c';
const DURATION = 0.5;

// A single pulse must rise off the baseline and come back to exactly the
// colour it started from.
try {
  let state = beginPulse(createHud(HEAL_GREEN), { duration: DURATION, flashColor: FLASH_ACCENT });
  const mid = advancePulse(state, DURATION / 2);
  const end = advancePulse(mid, DURATION);
  assert.strictEqual(mid.color !== HEAL_GREEN, true, 'the bar never tinted mid-flash');
  assert.strictEqual(end.active, false, 'the pulse stayed active after its duration');
  assert.strictEqual(end.color, HEAL_GREEN, 'single pulse settled on ' + end.color);
  check('single pulse returns exactly to the baseline colour', true, '');
} catch (error) {
  check('single pulse returns exactly to the baseline colour', false, detailOf(error));
}

// Two pulses that overlap must still settle on the baseline, because the
// resting colour of the bar never changed while it was flashing.
try {
  let state = createHud(HEAL_GREEN);
  state = beginPulse(state, { duration: DURATION, flashColor: FLASH_ACCENT });
  state = advancePulse(state, DURATION / 2);
  state = beginPulse(state, { duration: DURATION, flashColor: FLASH_ACCENT });
  state = advancePulse(state, DURATION / 2);
  state = advancePulse(state, DURATION);
  assert.strictEqual(state.active, false, 'the pulse stayed active after its duration');
  assert.strictEqual(state.color, HEAL_GREEN, 'overlapping pulses settled on ' + state.color);
  check('two overlapping pulses still return exactly to the baseline colour', true, '');
} catch (error) {
  check('two overlapping pulses still return exactly to the baseline colour', false, detailOf(error));
}

// Rapid hits must not let the bar drift away from the colour it started on.
try {
  let state = createHud(HEAL_GREEN);
  for (let hit = 0; hit < 5; hit += 1) {
    state = beginPulse(state, { duration: DURATION, flashColor: FLASH_ACCENT });
    state = advancePulse(state, DURATION / 2);
  }
  state = advancePulse(state, DURATION);
  assert.strictEqual(state.color, HEAL_GREEN, 'five rapid hits drifted to ' + state.color);
  check('five rapid hits never drift the bar colour', true, '');
} catch (error) {
  check('five rapid hits never drift the bar colour', false, detailOf(error));
}

// The flash has to actually be a flash, otherwise the checks above are empty.
try {
  let state = beginPulse(createHud(HEAL_GREEN), { duration: DURATION, flashColor: FLASH_ACCENT });
  state = advancePulse(state, DURATION / 2);
  const style = pulseStyle(state);
  assert.notStrictEqual(style.color, HEAL_GREEN, 'the bar did not tint mid-flash');
  assert.strictEqual(channel(style.color, 0) > channel(HEAL_GREEN, 0), true, 'red channel did not rise');
  assert.strictEqual(style.scale > 1, true, 'scale did not rise above 1');
  check('a running pulse tints the bar away from the baseline', true, '');
} catch (error) {
  check('a running pulse tints the bar away from the baseline', false, detailOf(error));
}

// The phase is clamped: extra time must not push the style past full strength.
try {
  let state = beginPulse(createHud(HEAL_GREEN), { duration: DURATION, flashColor: FLASH_ACCENT });
  state = advancePulse(state, DURATION * 10);
  const phase = state.elapsed / state.duration;
  assert.strictEqual(phase, 1, 'phase ended at ' + phase);
  const style = pulseStyle(state);
  assert.strictEqual(style.scale, 1, 'settled scale was ' + style.scale);
  assert.strictEqual(style.color, HEAL_GREEN, 'settled colour was ' + style.color);
  check('a pulse advanced past its duration clamps to phase 1', true, '');
} catch (error) {
  check('a pulse advanced past its duration clamps to phase 1', false, detailOf(error));
}

// Every value handed to the view has to be a real number.
try {
  let state = beginPulse(createHud(HEAL_GREEN), { duration: DURATION, flashColor: FLASH_ACCENT });
  const seen = [];
  for (const delta of [0, 0.05, 0.1, 0.2, 0.5, 5, -3]) {
    state = advancePulse(state, delta);
    const style = pulseStyle(state);
    seen.push(String(style.scale));
    assert.strictEqual(Number.isFinite(style.scale), true, 'scale was ' + style.scale);
    assert.strictEqual(/^#[0-9a-f]{6}$/.test(style.color), true, 'colour was ' + style.color);
  }
  check('every style is finite and a valid colour', true, 'scales ' + seen.join('->'));
} catch (error) {
  check('every style is finite and a valid colour', false, detailOf(error));
}

// Re-triggering must not stretch or shrink the animation length.
try {
  let state = createHud(HEAL_GREEN);
  state = beginPulse(state, { duration: DURATION, flashColor: FLASH_ACCENT });
  state = advancePulse(state, DURATION / 2);
  state = beginPulse(state, { flashColor: FLASH_ACCENT });
  assert.strictEqual(state.duration, DURATION, 'duration changed to ' + state.duration);
  const style = pulseStyle(state);
  assert.strictEqual(style.scale, 1, 'a restarted pulse was not at rest, scale ' + style.scale);
  check('re-triggering keeps the duration and restarts the phase', true, '');
} catch (error) {
  check('re-triggering keeps the duration and restarts the phase', false, detailOf(error));
}

// The style is a fresh value, so the view can hold on to it safely.
try {
  const state = advancePulse(
    beginPulse(createHud(HEAL_GREEN), { duration: DURATION, flashColor: FLASH_ACCENT }),
    DURATION / 2
  );
  const first = pulseStyle(state);
  const second = pulseStyle(state);
  assert.notStrictEqual(first, second, 'pulseStyle handed out the same object twice');
  assert.strictEqual(first.color, second.color, 'pulseStyle was not stable');
  assert.strictEqual(state.color, first.color, 'pulseStyle disagreed with the state');
  check('pulseStyle is stable and returns a fresh object', true, '');
} catch (error) {
  check('pulseStyle is stable and returns a fresh object', false, detailOf(error));
}

let passed = 0;
let failed = 0;
for (const result of checks) {
  if (result.passed) {
    passed += 1;
    console.log('PASS ' + result.name);
  } else {
    failed += 1;
    console.log('FAIL ' + result.name + ' :: ' + result.detail);
  }
}
console.log('demo-project: ' + passed + ' passed, ' + failed + ' failed');

if (failed > 0) {
  process.exitCode = 1;
}
