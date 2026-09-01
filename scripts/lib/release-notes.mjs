// @ts-check
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Slices one version's section out of CHANGELOG.md to use as a GitHub release
// body. The compare link lives in the `##` version heading the slice starts
// *after*, so it is lifted out separately and re-appended as a footer -
// otherwise the release page carries no link to the diff it shipped.

/**
 * A heading belongs to the version when nothing, whitespace, or the `(` of the
 * date suffix follows it - `0.1.3` must not claim `0.1.30`'s section.
 * @param {string} heading normalized heading text
 * @param {string} version
 */
function headingIsVersion(heading, version) {
  if (!heading.startsWith(version)) return false;
  const rest = heading.slice(version.length);
  return rest === "" || rest.startsWith("(") || /^\s/.test(rest);
}

/** @param {string} text */
function normalizeHeading(text) {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^v/, "")
    .trim();
}

/**
 * @param {string} changelog contents of CHANGELOG.md
 * @param {string} version release version without the `v` prefix, e.g. `0.1.3`
 * @returns {string} the release body, without a trailing newline
 */
export function buildReleaseNotes(changelog, version) {
  const lines = changelog.split(/\r?\n/);

  let start = -1;
  let end = lines.length;
  let compareUrl = "";

  for (let i = 0; i < lines.length; i++) {
    const match = /^##\s+(.+?)\s*$/.exec(lines[i]);
    if (!match) continue;

    if (start === -1 && headingIsVersion(normalizeHeading(match[1]), version)) {
      start = i + 1;
      compareUrl = /\]\((https:\/\/[^)\s]+\/compare\/[^)\s]+)\)/.exec(match[1])?.[1] ?? "";
      continue;
    }

    if (start !== -1) {
      end = i;
      break;
    }
  }

  if (start === -1) return `See CHANGELOG.md for changes in ${version}.`;

  const section = lines.slice(start, end).join("\n").trim();

  const body = section || "No changelog-visible changes in this release - it carries only chore, docs, CI or test commits.";

  return compareUrl ? `${body}\n\n**Full Changelog**: ${compareUrl}` : body;
}
