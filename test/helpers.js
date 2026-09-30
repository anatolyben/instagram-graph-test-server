// Shared by the test files: the app, a recording webhook callback, and a
// server with a Graph client and Instagram Business Login.
import http from "node:http";

import { startTestServer } from "../src/index.js";

export const APP = {
  id: "1234567890",
  secret: "test-app-secret",
  redirectUris: ["http://localhost:4000/instagram/callback"],
};
export const SCOPES = [
  "instagram_business_basic",
  "instagram_business_manage_comments",
  "instagram_business_content_publish",
  "instagram_business_manage_messages",
];

/** Run by each test file's afterEach. */
export const cleanups = [];

/** A webhook callback that answers Meta's handshake and records deliveries. */
export async function startCallback({
  verifyToken = "verify-me",
  status = 200,
} = {}) {
  const deliveries = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (request.method === "GET") {
      const ok =
        url.searchParams.get("hub.mode") === "subscribe" &&
        url.searchParams.get("hub.verify_token") === verifyToken;
      response
        .writeHead(ok ? 200 : 403)
        .end(ok ? url.searchParams.get("hub.challenge") : "");
      return;
    }
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks);
      deliveries.push({
        raw,
        headers: request.headers,
        body: JSON.parse(raw.toString("utf8")),
      });
      response.writeHead(status).end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  return {
    url: `http://127.0.0.1:${server.address().port}/webhook`,
    verifyToken,
    deliveries,
  };
}

export async function setup(options = {}) {
  const server = await startTestServer({ app: APP, ...options });
  cleanups.push(() => server.stop());

  async function graph(method, path, { token, query = {}, form } = {}) {
    const url = new URL(`/v25.0/${path}`, server.origin);
    for (const [key, value] of Object.entries(query))
      url.searchParams.set(key, value);
    const response = await fetch(url, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(form
          ? { "content-type": "application/x-www-form-urlencoded" }
          : {}),
      },
      ...(form ? { body: new URLSearchParams(form) } : {}),
    });
    return {
      status: response.status,
      headers: response.headers,
      body: await response.json(),
    };
  }

  /** Run Instagram Business Login end to end and return a long-lived token. */
  async function login(accountId, scopes = SCOPES) {
    await server.setNextLogin({ account_id: accountId });
    const authorize = new URL("/oauth/authorize", server.origin);
    authorize.search = new URLSearchParams({
      client_id: APP.id,
      redirect_uri: APP.redirectUris[0],
      response_type: "code",
      scope: scopes.join(","),
      state: "xyz",
    });
    const redirect = await fetch(authorize, { redirect: "manual" });
    const back = new URL(redirect.headers.get("location"));
    const exchange = await fetch(
      new URL("/oauth/access_token", server.origin),
      {
        method: "POST",
        body: new URLSearchParams({
          client_id: APP.id,
          client_secret: APP.secret,
          grant_type: "authorization_code",
          redirect_uri: APP.redirectUris[0],
          code: back.searchParams.get("code"),
        }),
      },
    );
    const short = (await exchange.json()).data[0];
    const longUrl = new URL("/access_token", server.origin);
    longUrl.search = new URLSearchParams({
      grant_type: "ig_exchange_token",
      client_secret: APP.secret,
      access_token: short.access_token,
    });
    const long = await (await fetch(longUrl)).json();
    return { state: back.searchParams.get("state"), short, long };
  }

  return { server, graph, login };
}
