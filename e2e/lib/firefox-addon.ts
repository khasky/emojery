// SPDX-License-Identifier: GPL-3.0-or-later
//
// Firefox has no `--load-extension`: the only unattended way to load an
// unpacked build is a TEMPORARY ADD-ON install over the Firefox Remote
// Debugging Protocol (the `about:debugging` path, the same one web-ext drives).
// This module owns that seam for the E2E_BROWSER=firefox runs: the prefs the
// browser must launch with, and the RDP exchange that installs the build.
//
// Temporary installs skip signing, live until the browser closes (the launcher
// re-installs on every launch, so restart-persistence specs still work), and
// keep storage/IndexedDB across relaunches of the same profile because both the
// gecko id (manifest) and the internal UUID (pref below) stay fixed.
import { readFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { resolve } from "node:path";

// The internal UUID Firefox mints per profile for `moz-extension://<uuid>/...`
// URLs, pinned via the `extensions.webextensions.uuids` pref so extension pages
// are addressable without asking the browser. Any fixed UUID works.
export const FIREFOX_EXTENSION_UUID = "6e2e7e2e-0e2e-4e2e-8e2e-e2e7e2e7e2e7";

export function geckoIdFromManifest(extensionPath: string): string {
  const manifest = JSON.parse(readFileSync(resolve(extensionPath, "manifest.json"), "utf8")) as {
    browser_specific_settings?: { gecko?: { id?: string } };
  };
  const id = manifest.browser_specific_settings?.gecko?.id;
  if (!id) throw new Error(`No browser_specific_settings.gecko.id in ${extensionPath}/manifest.json - is this a firefox build?`);
  return id;
}

// user.js prefs for a debuggable run: enable the RDP server the CLI arg starts,
// drop its connection prompt (nobody is there to click it), and pin the
// extension-page UUID. `intl.locale.requested` is the Firefox counterpart of
// Chrome's `--lang` - it sets the UI locale chrome.i18n resolves against, and
// `media.volume_scale` is its counterpart of `--mute-audio` (lib/launch-args.ts):
// a YouTube or reel fixture autoplays, and the chromium runs have been silent
// since that flag went in. Scaling output to zero rather than blocking autoplay
// (`media.autoplay.default`) keeps parity with Chrome - the video still plays, so
// the action row the suite measures renders the same either way.
export function firefoxRunPrefs(opts: { geckoId: string; locale?: string | undefined }): Record<string, string | number | boolean> {
  return {
    "devtools.debugger.remote-enabled": true,
    "devtools.debugger.prompt-connection": false,
    "extensions.webextensions.uuids": JSON.stringify({ [opts.geckoId]: FIREFOX_EXTENSION_UUID }),
    "media.volume_scale": "0.0",
    ...(opts.locale ? { "intl.locale.requested": opts.locale } : {}),
  };
}

// Minimal RDP client
// Wire format: `<byteLength>:<json>` packets both ways. The exchange here is
// three packets deep (hello -> getRoot -> installTemporaryAddon), so a real
// protocol library would be dead weight.

type RdpPacket = Record<string, unknown> & { from?: string };

class RdpConnection {
  private buffer = Buffer.alloc(0);
  private waiters: Array<{ match: (p: RdpPacket) => boolean; resolve: (p: RdpPacket) => void; reject: (e: Error) => void }> = [];

  constructor(private socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      // A throw from inside a socket event handler is an uncaughtException that
      // kills the whole runner - surface a framing break to the pending waiters
      // instead, where it lands in the installer's await with its detail intact.
      try {
        this.drain();
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        for (const waiter of this.waiters.splice(0)) waiter.reject(error);
        this.socket.destroy();
      }
    });
  }

  private drain(): void {
    for (;;) {
      const sep = this.buffer.indexOf(0x3a); // ':'
      if (sep === -1) return;
      const length = Number(this.buffer.subarray(0, sep).toString("ascii"));
      if (!Number.isFinite(length)) throw new Error(`RDP framing broke: ${this.buffer.subarray(0, 40).toString()}`);
      if (this.buffer.length < sep + 1 + length) return;
      const packet = JSON.parse(this.buffer.subarray(sep + 1, sep + 1 + length).toString("utf8")) as RdpPacket;
      this.buffer = this.buffer.subarray(sep + 1 + length);
      const index = this.waiters.findIndex((w) => w.match(packet));
      if (index !== -1) {
        const [waiter] = this.waiters.splice(index, 1);
        waiter?.resolve(packet);
      }
      // Unsolicited packets (tab lists, actor events) are dropped on purpose.
    }
  }

  send(packet: Record<string, unknown>): void {
    const json = JSON.stringify(packet);
    this.socket.write(`${Buffer.byteLength(json)}:${json}`);
  }

  waitFor(match: (p: RdpPacket) => boolean, what: string, timeoutMs = 15_000): Promise<RdpPacket> {
    return new Promise((resolvePacket, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${what} over RDP`)), timeoutMs);
      this.waiters.push({
        match,
        resolve: (p) => {
          clearTimeout(timer);
          resolvePacket(p);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  end(): void {
    this.socket.end();
    this.socket.destroy();
  }
}

// The debugger server comes up asynchronously with the browser, so the first
// connects can be refused - retry to a deadline.
async function connectWithRetry(port: number, timeoutMs = 20_000): Promise<Socket> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await new Promise<Socket>((resolveSocket, reject) => {
        const socket = connect({ host: "127.0.0.1", port }, () => resolveSocket(socket));
        socket.once("error", reject);
      });
    } catch (err) {
      if (Date.now() >= deadline) throw new Error(`Could not reach the Firefox debugger server on port ${port}: ${String(err)}`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

// Install the unpacked build as a temporary add-on: hello -> getRoot for the
// addons actor -> installTemporaryAddon. Errors from the actor surface verbatim.
export async function installTemporaryAddon(port: number, addonPath: string): Promise<void> {
  const socket = await connectWithRetry(port);
  const rdp = new RdpConnection(socket);
  try {
    const hello = rdp.waitFor((p) => p.from === "root", "the root hello");
    await hello;
    rdp.send({ to: "root", type: "getRoot" });
    const root = await rdp.waitFor((p) => p.from === "root" && typeof p.addonsActor === "string", "the addons actor");
    const addonsActor = root.addonsActor as string;
    rdp.send({ to: addonsActor, type: "installTemporaryAddon", addonPath: resolve(addonPath), openDevTools: false });
    const result = await rdp.waitFor((p) => p.from === addonsActor, "the temporary-addon install", 30_000);
    if (result.error) throw new Error(`Temporary add-on install failed: ${String(result.message ?? result.error)}`);
  } finally {
    rdp.end();
  }
}
