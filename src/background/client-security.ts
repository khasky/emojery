// SPDX-License-Identifier: GPL-3.0-or-later
//
// Opaque client identifiers used by API requests. They are not secrets, and they carry
// nothing user-derived - both are random. The install id persists for the lifetime of the
// installation; the session id rotates on the TTL below.

import { randomId } from "../shared/random-id";
import { storageLocalGet, storageLocalSet } from "../shared/webext";

const SECURITY_CONTEXT_KEY = "security_context_v1";
// Exported so client-security.test.ts probes the real rotation boundary. A copy of
// the number there would still pass if the TTL shrank, silently stopping short of it.
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

interface StoredSecurityContext {
  installId?: unknown;
  sessionId?: unknown;
  sessionStartedAt?: unknown;
}

interface ClientSecurityContext {
  installId: string;
  sessionId: string;
}

export async function getClientSecurityContext(now: number = Date.now()): Promise<ClientSecurityContext> {
  const stored = await storageLocalGet([SECURITY_CONTEXT_KEY]);
  const raw = stored[SECURITY_CONTEXT_KEY] as StoredSecurityContext | undefined;

  let installId = normalizeStoredId(raw?.installId);
  let sessionId = normalizeStoredId(raw?.sessionId);
  let sessionStartedAt = typeof raw?.sessionStartedAt === "number" && Number.isFinite(raw.sessionStartedAt) ? raw.sessionStartedAt : 0;
  let changed = false;

  if (!installId) {
    installId = randomId();
    changed = true;
  }

  if (!sessionId || sessionStartedAt <= 0 || now - sessionStartedAt >= SESSION_TTL_MS) {
    sessionId = randomId();
    sessionStartedAt = now;
    changed = true;
  }

  if (changed) {
    await storageLocalSet({
      [SECURITY_CONTEXT_KEY]: { installId, sessionId, sessionStartedAt },
    });
  }

  return { installId, sessionId };
}

export async function clientSecurityHeaders(): Promise<Record<string, string>> {
  const ctx = await getClientSecurityContext();
  return {
    "x-emojery-install-id": ctx.installId,
    "x-emojery-session-id": ctx.sessionId,
  };
}

function normalizeStoredId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(id)) return null;
  return id;
}
