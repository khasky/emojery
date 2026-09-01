// SPDX-License-Identifier: GPL-3.0-or-later
import type { RuntimeMessage, RuntimeResponse } from "../shared/messages";
import { sendRuntimeMessage } from "../shared/webext";

// Lives in its own module so the mount and vote modules can share it without an import cycle.
export function sendMessage(msg: RuntimeMessage): Promise<RuntimeResponse> {
  return sendRuntimeMessage(msg).then((response) => {
    if (!response) throw new Error("runtime response missing");
    return response;
  });
}

// The signed-in account, asked of the background rather than read out of the stored auth
// record: `storage.local.get` cannot project fields, so reading it would pull the bearer
// token into a hostile page's content-script heap for a value the background already hands
// out (and whose expiry it checks). Signed out on a failed trip or any other reply shape.
export function authStatus(): Promise<{ authed: boolean; userId: string | null }> {
  return sendMessage({ type: "auth:status" })
    .then((response) => (response.type === "auth:status" ? { authed: response.authed, userId: response.userId } : { authed: false, userId: null }))
    .catch(() => ({ authed: false, userId: null }));
}

export function activeUserId(): Promise<string | null> {
  return authStatus().then((status) => status.userId);
}
