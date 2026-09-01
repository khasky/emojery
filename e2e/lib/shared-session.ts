// SPDX-License-Identifier: GPL-3.0-or-later
//
// One browser for a whole spec file. `sharedSession()` wires the beforeAll /
// afterAll pair in one place, so a spec that needs nothing but a plain session
// cannot copy half of it - a missing afterAll leaks a headed Chromium and its
// profile dir for the rest of the run.
//
// Its own module, not part of browser-session.ts: this one imports
// `@playwright/test`, and browser-session is reachable from modules the vitest
// site-auth suite loads.
import { test } from "@playwright/test";
import { closeSession, launchSession, type Session } from "./browser-session";

/** Registers the beforeAll/afterAll pair and hands back a GETTER - the session
 *  itself does not exist until `beforeAll` has run. */
export function sharedSession(): () => Session {
  let session: Session | undefined;

  test.beforeAll(async () => {
    session = await launchSession();
  });

  test.afterAll(async () => {
    if (session) await closeSession(session);
  });

  return () => {
    if (!session) throw new Error("sharedSession: the session is only available once beforeAll has run");
    return session;
  };
}
