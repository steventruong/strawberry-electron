"use strict";

const { redactionCount } = require("./redactor");

const state = {
  queueDepth: 0,
  drops: 0,
  retries: 0,
  failures: 0,
  breaker: "CLOSED", // CLOSED | HALF_OPEN | OPEN
};

function recordDrop() {
  state.drops++;
}

function recordRetry() {
  state.retries++;
}

function recordFailure() {
  state.failures++;
}

function setQueueDepth(v) {
  state.queueDepth = v;
}

function setBreaker(s) {
  state.breaker = s;
}

function snapshot() {
  return {
    queue_depth: state.queueDepth,
    drops: state.drops,
    retries: state.retries,
    failures: state.failures,
    breaker_state: state.breaker,
    redaction_count: redactionCount(),
  };
}

module.exports = {
  recordDrop,
  recordRetry,
  recordFailure,
  setQueueDepth,
  setBreaker,
  snapshot,
};
