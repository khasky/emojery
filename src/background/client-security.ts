// SPDX-License-Identifier: GPL-3.0-or-later
//
// Opaque client identifier used by API requests. It is not a secret, and it carries
// nothing user-derived - it is random. The install id persists for the lifetime of the
// installation.

import { randomId } from "../shared/random-id";
import { storageLocalGet, storageLocalSet } from "../shared/webext";

const SECURITY_CONTEXT_KEY = "security_context_v1";

interface StoredSecurityContext {
  installId?: unknown;
  sessionId?: unknown;
  sessionStartedAt?: unknown;
}

interface ClientSecurityContext {
  installId: string;
}

export async function getClientSecurityContext(): Promise<ClientSecurityContext> {
  const stored = await storageLocalGet([SECURITY_CONTEXT_KEY]);
  const raw = stored[SECURITY_CONTEXT_KEY] as StoredSecurityContext | undefined;

  let installId = normalizeStoredId(raw?.installId);
  const staleSession = raw !== undefined && ("sessionId" in raw || "sessionStartedAt" in raw);

  if (!installId) installId = randomId();

  if (installId !== raw?.installId || staleSession) {
    await storageLocalSet({ [SECURITY_CONTEXT_KEY]: { installId } });
  }

  return { installId };
}

export async function clientSecurityHeaders(): Promise<Record<string, string>> {
  const ctx = await getClientSecurityContext();
  return { "x-emojery-install-id": ctx.installId };
}

function normalizeStoredId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(id)) return null;
  return id;
}
