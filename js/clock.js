// Simulation clock shared by all views. Views call now() inside their own
// render loops. The time bar UI drives setTime / setRate / goLive.
import { emit } from './state.js';

let anchorReal = Date.now();   // real ms at last anchor
let anchorSim = Date.now();    // simulated ms at last anchor
let rate = 1;                  // sim seconds per real second
let live = true;

export function now() {
  return anchorSim + (Date.now() - anchorReal) * rate;
}
export function nowDate() { return new Date(now()); }
export function isLive() { return live; }
export function getRate() { return rate; }

function reanchor() { anchorSim = now(); anchorReal = Date.now(); }

export function setTime(ms) {
  anchorSim = ms; anchorReal = Date.now();
  live = Math.abs(ms - Date.now()) < 2000 && rate === 1;
  emit('clock', { time: ms, rate, live });
}
export function setRate(r) {
  reanchor(); rate = r;
  live = live && r === 1;
  emit('clock', { time: now(), rate, live });
}
export function goLive() {
  anchorSim = Date.now(); anchorReal = Date.now(); rate = 1; live = true;
  emit('clock', { time: now(), rate, live });
}
