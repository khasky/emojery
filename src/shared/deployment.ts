// SPDX-License-Identifier: GPL-3.0-or-later
//
// Which deployment this build talks to, read off the API origin the build was made for: the
// provider table, the log's name and its first origin come from @emojery/shared/api by this.

import { initialOrigin, LOG_NAMES } from "@emojery/shared/api";
import { PRODUCTION_API_BASE } from "./api-origins";
import { API_BASE } from "./config";

export type Deployment = "production" | "staging";

export const DEPLOYMENT: Deployment = API_BASE === PRODUCTION_API_BASE ? "production" : "staging";

/** The log's name; every origin is `<LOG_NAME>/g<k>`. */
export const LOG_NAME: string = LOG_NAMES[DEPLOYMENT];

/** The origin a device signs under until a sign-in names the current one. */
export const INITIAL_ORIGIN: string = initialOrigin(DEPLOYMENT);

/** Where the log's files are served; the extension reads only index.json, at an origin switch. */
export const LOG_BASE_URL: string = `https://${LOG_NAME}`;

// The log's signing key per deployment (base64, 32 bytes): a new origin is taken only from a
// rewind record in index.json signed by it. Empty: no switch is ever accepted.
const LOG_PUBKEYS: Readonly<Record<Deployment, string>> = {
  production: "",
  staging: "P37N5YTTgfbn4L1oW4lLnQM7BsHQEYgY4QpnkYLNEaM=",
};
export const LOG_PUBKEY: string = LOG_PUBKEYS[DEPLOYMENT];
