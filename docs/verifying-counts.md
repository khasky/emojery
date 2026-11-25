# Verifying the counts

This repo only casts votes. The public record of every accepted reaction, and the tool that recounts it, live elsewhere:

- [`emojery-verifier`](https://github.com/khasky/emojery-verifier) — the open-source verifier: it reads the public log at `log.emojery.app` and checks it against the signed checkpoints, with no privileged access. Run it with `npx @emojery/verifier`; its README lists the modes.
- [`emojery-tlog`](https://github.com/khasky/emojery-tlog) — the public mirror of the log's signed checkpoints and their anchors. The staging backend (`pnpm build`, [adding-a-site.md step 11](adding-a-site.md#11-manual-smoke-on-the-live-site--against-the-staging-api)) has its own, [`emojery-tlog-staging`](https://github.com/khasky/emojery-tlog-staging).
- [Concepts](https://github.com/khasky/emojery-verifier/blob/main/docs/concepts.md) and the [protocol](https://github.com/khasky/emojery-verifier/blob/main/docs/PROTOCOL.md) — the log in plain words, and its byte-level specification.

The one part of the contract this repo does own: the URL→`targetId` derivation the adapters emit is the key every logged reaction is stored under, which is why it's a permanent wire contract — see [adding-a-site.md step 5](adding-a-site.md#5-the-canonical-id-is-a-wire-contract) and `src/adapters/lockstep.test.ts`.
