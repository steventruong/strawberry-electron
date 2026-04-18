"use strict";

/**
 * Jittered decorrelated exponential backoff.
 *
 *   next = random(base, min(cap, previous * 3))
 *
 * Matches the AWS decorrelated-jitter recipe.
 */
class Backoff {
  constructor(baseMs = 250, capMs = 30000) {
    this.baseMs = baseMs;
    this.capMs = capMs;
    this.previousMs = baseMs;
  }

  nextMs() {
    const upper = Math.min(this.capMs, this.previousMs * 3);
    const lo = this.baseMs;
    const hi = upper <= lo ? lo + 1 : upper;
    const next = Math.floor(lo + Math.random() * (hi - lo));
    this.previousMs = next;
    return next;
  }

  reset() {
    this.previousMs = this.baseMs;
  }
}

module.exports = { Backoff };
