// SPDX-License-Identifier: GPL-3.0-or-later
//
// One opaque-random-id generator for every caller that needs an unguessable
// local identifier (the queued vote's optimistic history row, the install and
// session ids sent as client-security headers). Not a secret and not a hash of
// anything user-derived - just randomness.
//
// The output always matches /^[A-Za-z0-9_-]{16,128}$/ so a stored id survives
// the readback validation in background/client-security.ts.

export function randomId(): string {
  // Present in every MV3/MV2 context the extension runs in; the second branch exists
  // for a runtime that ships getRandomValues without randomUUID.
  if (typeof crypto !== "undefined") {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    if (typeof crypto.getRandomValues === "function") {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      let out = "";
      for (const b of bytes) out += b.toString(16).padStart(2, "0");
      return out;
    }
  }
  // No CSPRNG: throw rather than fall back to Date.now() + Math.random() - a
  // predictable id would be worse than none, and `jsonApiHeaders` already absorbs
  // the throw by sending the request without those headers. Unreachable in a
  // browser; failing loud is what keeps it that way.
  throw new Error("randomId: no Web Crypto (crypto.randomUUID / crypto.getRandomValues) in this context");
}
