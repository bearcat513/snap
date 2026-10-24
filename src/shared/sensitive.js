// Sensitive-text patterns for suggested redactions (§6 smart redaction).
// Classic script: injected into pages next to content/sensitive-scan.js (defines
// globalThis.SnapSensitive) and imported for side effects by the unit tests.
(function (root) {
  'use strict';

  function luhn(digits) {
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2) { d *= 2; if (d > 9) d -= 9; }
      sum += d;
    }
    return sum % 10 === 0;
  }

  const digitsOf = (s) => s.replace(/\D/g, '');

  // Each pattern: a global regex plus an optional check on the matched text.
  const BUILTIN = {
    email: { re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g },
    phone: {
      re: /(?<![\w.])\+?\(?\d{1,4}\)?(?:[ .-]\(?\d{2,5}\)?){1,4}(?!\w|\.\d)/g,
      check: (m) => {
        const d = digitsOf(m);
        if (d.length < 9 || d.length > 15) return false;
        if (/^\d{4}-\d{2}-\d{2}/.test(m) || /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}/.test(m)) return false; // dates
        return !/^(\d)\1+$/.test(d);
      },
    },
    ipv4: { re: /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\d.])/g },
    card: {
      re: /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g,
      check: (m) => { const d = digitsOf(m); return d.length >= 13 && d.length <= 19 && luhn(d); },
    },
    token: {
      // JWTs, well-known key prefixes, and long mixed-case strings (not lower-case hex sys_ids).
      re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{12,}|\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b|(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{32,}={0,2}(?![A-Za-z0-9+/_-])/g,
      check: (m) => m.startsWith('eyJ') || /^(sk|pk|rk)_|^gh|^github_pat_|^xox|^AKIA/.test(m) || (/[a-z]/.test(m) && /[A-Z]/.test(m) && /\d/.test(m)),
    },
  };

  /** Compile user patterns; invalid ones are skipped. Returns [{ kind: 'custom', re }]. */
  function compileCustom(list) {
    const out = [];
    for (const src of list || []) {
      if (typeof src !== 'string' || !src.trim()) continue;
      try { out.push({ kind: 'custom', re: new RegExp(src, 'g') }); } catch { /* invalid regex */ }
    }
    return out;
  }

  /**
   * Find sensitive substrings in `text`. opts: { patterns: string[] (built-in ids), custom: string[] }.
   * Returns non-overlapping [{ start, end, kind }] sorted by start.
   */
  function findMatches(text, opts) {
    const enabled = (opts && opts.patterns) || Object.keys(BUILTIN);
    const rules = enabled.filter((k) => BUILTIN[k]).map((k) => ({ kind: k, re: BUILTIN[k].re, check: BUILTIN[k].check }))
      .concat(compileCustom(opts && opts.custom));
    const found = [];
    for (const r of rules) {
      r.re.lastIndex = 0;
      let m;
      let guard = 0;
      while ((m = r.re.exec(text)) && guard++ < 1000) {
        if (!m[0]) { r.re.lastIndex++; continue; }
        if (!r.check || r.check(m[0])) found.push({ start: m.index, end: m.index + m[0].length, kind: r.kind });
      }
    }
    // Longest first wins where matches overlap (an email beats the phone number inside it).
    found.sort((a, b) => (b.end - b.start) - (a.end - a.start));
    const kept = [];
    for (const f of found) if (!kept.some((k) => f.start < k.end && k.start < f.end)) kept.push(f);
    return kept.sort((a, b) => a.start - b.start);
  }

  root.SnapSensitive = { BUILTIN_KINDS: Object.keys(BUILTIN), findMatches, luhn };
})(typeof globalThis !== 'undefined' ? globalThis : this);
