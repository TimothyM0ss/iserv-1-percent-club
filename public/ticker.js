'use strict';

const Ticker = (() => {
  const VOLUME = 0.5;
  const TICK_HZ = 1500;
  const TOCK_HZ = 1100;
  const CLICK_SECONDS = 0.06;

  let context = null;
  let output = null;
  let on = false;

  function click(when, hz) {
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.type = 'triangle';
    osc.frequency.value = hz;
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(0.6, when + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + CLICK_SECONDS);
    osc.connect(gain).connect(output);
    osc.start(when);
    osc.stop(when + CLICK_SECONDS + 0.01);
  }

  function stop() {
    output?.disconnect();
    output = null;
  }

  // Browsers allow audio only after a user gesture, so call this from a click handler.
  async function setOn(value) {
    on = value;
    if (!on) return stop();
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    context ??= new AudioContextClass();
    await context.resume();
  }

  function start(remainingMs) {
    stop();
    if (!on || context?.state !== 'running') return;
    output = context.createGain();
    output.gain.value = VOLUME;
    output.connect(context.destination);
    const begin = context.currentTime;
    for (let second = 0; second * 1000 < remainingMs; second++) {
      click(begin + second, second % 2 === 0 ? TICK_HZ : TOCK_HZ);
    }
  }

  return { setOn, start, stop, get isOn() { return on; } };
})();
