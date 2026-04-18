"use strict";

/**
 * PII redactor. Scrubs emails, phone numbers, Luhn-valid credit cards,
 * JWTs, API-key prefixes (sk_, sbk_, berry_, wt_live_, ghp_, AKIA), and
 * values for denylisted field names. Applied to every outgoing property
 * map by default. Per-call opt-out via raw = true.
 *
 * Clean-room implementation.
 */

const REDACTED = "[REDACTED]";
const MAX_DEPTH = 8;
const MAX_STRING_LEN = 20000;

const DENYLIST = [
  "password",
  "passwd",
  "pwd",
  "token",
  "secret",
  "cookie",
  "authorization",
  "auth",
  "api_key",
  "apikey",
  "ssn",
  "social_security",
  "credit",
  "card",
  "cvv",
  "cvc",
  "pin",
];

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)?\d{3}[\s.-]?\d{4}/g;
const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const API_KEY_RE = /\b(?:sk_|sbk_|berry_|wt_live_|ghp_)[A-Za-z0-9_]{8,}\b|\bAKIA[0-9A-Z]{16}\b/g;
const CARD_RE = /\b(?:\d[ -]?){13,19}\b/g;

let _count = 0;

function redactionCount() {
  return _count;
}

function resetRedactionCount() {
  _count = 0;
}

function isDenylisted(key) {
  const lower = String(key).toLowerCase();
  for (const bad of DENYLIST) {
    if (lower.indexOf(bad) !== -1) return true;
  }
  return false;
}

function luhnValid(digits) {
  if (!digits) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    const n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    let d = n;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function redactString(input) {
  if (typeof input !== "string" || input.length === 0) return input;
  let s = input.length > MAX_STRING_LEN ? input.slice(0, MAX_STRING_LEN) : input;
  let changed = false;

  if (API_KEY_RE.test(s)) {
    s = s.replace(API_KEY_RE, REDACTED);
    changed = true;
  }
  if (JWT_RE.test(s)) {
    s = s.replace(JWT_RE, REDACTED);
    changed = true;
  }
  if (EMAIL_RE.test(s)) {
    s = s.replace(EMAIL_RE, REDACTED);
    changed = true;
  }

  s = s.replace(CARD_RE, (m) => {
    const digits = m.replace(/[^0-9]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
      changed = true;
      return REDACTED;
    }
    return m;
  });

  s = s.replace(PHONE_RE, (m) => {
    const digits = m.replace(/[^0-9]/g, "");
    if (digits.length >= 10 && digits.length <= 15) {
      changed = true;
      return REDACTED;
    }
    return m;
  });

  if (changed) _count++;
  return s;
}

function redactValue(value, depth) {
  if (depth > MAX_DEPTH) return REDACTED;
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, depth + 1));
  }
  const out = {};
  for (const k of Object.keys(value)) {
    if (isDenylisted(k)) {
      _count++;
      out[k] = REDACTED;
    } else {
      out[k] = redactValue(value[k], depth + 1);
    }
  }
  return out;
}

function redact(input, raw) {
  if (!input) return {};
  if (raw === true) return input;
  return redactValue(input, 0);
}

module.exports = {
  redact,
  redactString,
  redactionCount,
  resetRedactionCount,
};
