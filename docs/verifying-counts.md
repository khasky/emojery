# Verifying the counts

This repo only casts votes. The public record of every accepted reaction, and the tool that recounts it, live in other repositories:

- [`emojery-log`](https://github.com/khasky/emojery-log) — the public, append-only transparency log: signed Merkle checkpoints of every counter-changing event, anchored to Bitcoin (OpenTimestamps), Sigstore Rekor, and Software Heritage. A plain `git clone` is a complete, offline-verifiable copy.
- [`emojery-verifier`](https://github.com/khasky/emojery-verifier) — the standalone open-source tool that refetches the log's leaves, recomputes every hash and the Merkle root, checks the signed checkpoints, and folds the log back into counters. It talks only to the public API and the public log; no privileged access. Quick start, no clone needed:

  ```bash
  npx github:khasky/emojery-verifier --api https://api.emojery.app \
    --repo https://raw.githubusercontent.com/khasky/emojery-log/main
  ```

The staging backend (`pnpm build:staging`, [adding-a-site.md step 11](adding-a-site.md#11-manual-smoke-on-the-live-site--against-the-staging-api)) publishes its own log to [`emojery-log-staging`](https://github.com/khasky/emojery-log-staging), periodically reset to genesis.

The one part of the contract this repo does own: the URL→`targetId` derivation the adapters emit is the key every logged reaction is stored under, which is why it's a permanent wire contract — see [adding-a-site.md step 5](adding-a-site.md#5-the-canonical-id-is-a-wire-contract) and `src/adapters/lockstep.test.ts`.
