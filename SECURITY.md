# Security policy

## Reporting a vulnerability

Report privately through GitHub, not in a public issue:

[Open a private security advisory](https://github.com/khasky/emojery/security/advisories/new)

Do not open a public issue, pull request, or discussion for a security problem, and do not post it anywhere else until a fix has shipped.

Useful in a report:

- what an attacker can do, and what they need first (a page, an account, a specific site, another extension installed);
- where it lives — a file, a page, or an extension surface (content script, popup, background worker);
- the browser and version, the extension version (`chrome://extensions` → Emojery), and the site you saw it on;
- the smallest reproduction you have — a snippet, a screen recording, or numbered steps;
- if it involves a page you cannot share, an equivalent public one.

Never include real credentials, session tokens, or another person's data. A redacted excerpt is enough.

## What to expect

- Acknowledgement within 7 working days.
- A first assessment (accepted / not a vulnerability / needs more detail) within 14 working days.
- Fixes ship in a normal release; a critical one gets an out-of-band release.
- Public disclosure is coordinated with you once the fix ships, or 90 days after the report — whichever comes first.
- Credit in the release notes and the advisory if you want it — say so in the report.

This is a solo, unpaid project: there is no bug bounty.

## Scope

In scope: this repository (the browser extension) and the public API it talks to.

Out of scope: vulnerabilities in Facebook, X, Reddit, YouTube, Instagram, Threads, GitHub, GitLab, Amazon, or any other site the extension runs on — report those to the site's own program. Also out of scope: findings that require a browser the extension does not support, physical access to an unlocked device, or social engineering of the maintainer.

## Safe harbor

Research done in good faith under this policy is welcome. Stay within your own accounts and your own data, do not degrade the service for anyone else, and give a reasonable window before disclosing. Under those conditions there will be no legal action from this project.

## Supported versions

Only the latest published release receives security fixes. It is listed on the [releases page](https://github.com/khasky/emojery/releases); the [Install section](README.md#install) of the README lists every way to get it.
