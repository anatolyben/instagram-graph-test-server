// Runs a real, independent Instagram client against the server: Vercel's Chat
// SDK Instagram adapter, which verifies Meta's webhook signature itself and
// sends its reply through the Graph API.
import http from "node:http";
import { createInstagramAdapter } from "@chat-adapter/instagram";
import { createMemoryState } from "@chat-adapter/state-memory";
import { Chat } from "chat";
import { afterEach, expect, it } from "vitest";

import { startTestServer } from "../src/index.js";

const APP = {
  id: "1234567890",
  secret: "test-app-secret",
  redirectUris: ["http://localhost:4000/instagram/callback"],
};
const VERIFY_TOKEN = "my-verify-token";

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

/** Serve a web-standard (Request) => Response handler over node:http. */
async function serve(handler) {
  const pending = [];
  const server = http.createServer(async (incoming, outgoing) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const request = new Request(`http://localhost${incoming.url}`, {
      method: incoming.method,
      headers: incoming.headers,
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    });
    const response = await handler(request, {
      waitUntil: (task) => pending.push(task),
    });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  return { url: `http://127.0.0.1:${server.address().port}/webhook`, pending };
}

async function longLivedToken(server, account) {
  await server.setNextLogin({ account_id: account.id });
  const authorize = new URL("/oauth/authorize", server.origin);
  authorize.search = new URLSearchParams({
    client_id: APP.id,
    redirect_uri: APP.redirectUris[0],
    response_type: "code",
    scope: "instagram_business_basic,instagram_business_manage_messages",
  });
  const code = new URL(
    (await fetch(authorize, { redirect: "manual" })).headers.get("location"),
  ).searchParams.get("code");
  const short = (
    await (
      await fetch(new URL("/oauth/access_token", server.origin), {
        method: "POST",
        body: new URLSearchParams({
          client_id: APP.id,
          client_secret: APP.secret,
          grant_type: "authorization_code",
          redirect_uri: APP.redirectUris[0],
          code,
        }),
      })
    ).json()
  ).data[0].access_token;
  const exchange = new URL("/access_token", server.origin);
  exchange.search = new URLSearchParams({
    grant_type: "ig_exchange_token",
    client_secret: APP.secret,
    access_token: short,
  });
  return (await (await fetch(exchange)).json()).access_token;
}

it("receives a signed message webhook and sends the reply through the Graph API", async () => {
  let bot;
  const webhook = await serve((request, options) =>
    bot.webhooks.instagram(request, options),
  );
  const server = await startTestServer({
    app: APP,
    webhook: { callbackUrl: webhook.url, verifyToken: VERIFY_TOKEN },
  });
  cleanups.push(() => server.stop());

  // The adapter's Graph API host is fixed; send it to the test server.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    return url.startsWith("https://graph.instagram.com/")
      ? realFetch(
          server.origin + url.slice("https://graph.instagram.com".length),
          init,
        )
      : realFetch(input, init);
  };
  cleanups.push(() => {
    globalThis.fetch = realFetch;
  });

  const shop = await server.createAccount({ username: "acme_store" });
  const token = await longLivedToken(server, shop);
  await fetch(
    new URL(`/v26.0/${shop.user_id}/subscribed_apps`, server.origin),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ subscribed_fields: "messages" }),
    },
  );

  bot = new Chat({
    userName: "acme_store",
    adapters: {
      instagram: createInstagramAdapter({
        accessToken: token,
        appSecret: APP.secret,
        verifyToken: VERIFY_TOKEN,
        accountId: shop.user_id,
      }),
    },
    state: createMemoryState(),
  });
  bot.onDirectMessage(async (thread, message) => {
    await thread.post(`You said: ${message.text}`);
  });

  const sent = await server.sendMessageToAccount(shop.id, {
    username: "customer",
    text: "Is this in stock? 👀",
  });

  // Meta's verification handshake and the signature check both passed.
  expect(sent.webhook.delivered).toBe(true);
  await expect
    .poll(async () =>
      (await server.getMessages()).map((message) => message.text),
    )
    .toEqual(["You said: Is this in stock? 👀"]);
  const [reply] = await server.getMessages();
  expect(reply.recipient).toEqual({ id: sent.person_id });
  await Promise.all(webhook.pending);
});
