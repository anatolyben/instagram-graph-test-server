#!/usr/bin/env node
/**
 * Run the fake as a standalone server.
 *
 *   instagram-graph-test-server --app-id 123 --app-secret shh --redirect-uri http://localhost:4000/cb \
 *     [--port 8083] [--host 127.0.0.1] [--webhook-url URL --verify-token TOKEN] [--download-media]
 *
 * Point the app's www.instagram.com, api.instagram.com and graph.instagram.com
 * hosts at the printed origin, and drive it through /_fake/*.
 */
import { parseArgs } from "node:util";
import { startTestServer } from "../src/index.js";

const { values } = parseArgs({
  options: {
    "app-id": { type: "string" },
    "app-secret": { type: "string" },
    "redirect-uri": { type: "string", multiple: true },
    port: { type: "string", default: "8083" },
    host: { type: "string", default: "127.0.0.1" },
    "webhook-url": { type: "string" },
    "verify-token": { type: "string" },
    "download-media": { type: "boolean", default: false },
  },
});

if (
  !values["app-id"] ||
  !values["app-secret"] ||
  !values["redirect-uri"]?.length
) {
  console.error(
    "Usage: instagram-graph-test-server --app-id <id> --app-secret <secret> --redirect-uri <url> [--redirect-uri <url>] [--port 8083] [--host 127.0.0.1] [--webhook-url <url> --verify-token <token>] [--download-media]",
  );
  process.exit(2);
}

const server = await startTestServer({
  app: {
    id: values["app-id"],
    secret: values["app-secret"],
    redirectUris: values["redirect-uri"],
  },
  port: Number(values.port),
  host: values.host,
  webhook: values["webhook-url"]
    ? {
        callbackUrl: values["webhook-url"],
        verifyToken: values["verify-token"] ?? "",
      }
    : null,
  downloadMedia: values["download-media"],
  log: (line) => console.log(`[instagram-graph-test-server] ${line}`),
});
console.log(`[instagram-graph-test-server] listening at ${server.origin}`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await server.stop();
    process.exit(0);
  });
}
