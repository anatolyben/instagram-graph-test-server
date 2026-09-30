// One app's whole inbox flow against the server, end to end over HTTP: connect
// a professional account through Instagram Business Login, subscribe to
// messaging webhooks, receive and verify two messages from a person, page
// the conversation history, reply, see the reply read, and check the calls
// ledger. Nothing here reaches Meta.
import { createHmac, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { afterEach, expect, it } from "vitest";

import { APP, cleanups, setup } from "./helpers.js";

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

/** An app's webhook receiver: Meta's handshake, then signed events only. */
async function startReceiver(verifyToken) {
  const events = [];
  const refused = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (request.method === "GET") {
      const ok = url.searchParams.get("hub.verify_token") === verifyToken;
      response
        .writeHead(ok ? 200 : 403)
        .end(ok ? url.searchParams.get("hub.challenge") : "");
      return;
    }
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks);
      const expected = Buffer.from(
        `sha256=${createHmac("sha256", APP.secret).update(raw).digest("hex")}`,
      );
      const given = Buffer.from(
        String(request.headers["x-hub-signature-256"] ?? ""),
      );
      if (
        given.length !== expected.length ||
        !timingSafeEqual(given, expected)
      ) {
        refused.push(raw);
        response.writeHead(401).end();
        return;
      }
      for (const entry of JSON.parse(raw.toString("utf8")).entry) {
        events.push(...(entry.messaging ?? []));
      }
      response.writeHead(200).end();
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
    url: `http://127.0.0.1:${server.address().port}/instagram/webhook`,
    events,
    refused,
  };
}

it("connects an account, receives two messages, pages history, replies and sees it read", async () => {
  const verifyToken = "inbox-verify";
  const receiver = await startReceiver(verifyToken);
  const { server, graph, login } = await setup({
    webhook: { callbackUrl: receiver.url, verifyToken },
  });
  const shop = await server.createAccount({
    username: "corner_shop",
    account_type: "BUSINESS",
  });
  const token = (await login(shop.id)).long.access_token;
  const me = await graph("GET", "me", {
    token,
    query: { fields: "user_id,username,account_type" },
  });
  expect(me.body.data[0]).toMatchObject({
    user_id: shop.user_id,
    account_type: "BUSINESS",
  });
  expect(
    (
      await graph("POST", "me/subscribed_apps", {
        token,
        form: { subscribed_fields: "messages,messaging_seen" },
      })
    ).body,
  ).toEqual({ success: true });

  // Two messages from a person, each verified by the receiver.
  const customer = await server.createCustomer(shop.id, { username: "ana" });
  const first = await server.sendMessageToAccount(shop.id, {
    person_id: customer.id,
    text: "Is the blue one in stock?",
  });
  await server.advanceClock(1_000);
  await server.sendMessageToAccount(shop.id, {
    person_id: customer.id,
    text: "Size M please",
  });
  expect(receiver.refused).toHaveLength(0);
  expect(receiver.events.map((event) => event.message.text)).toEqual([
    "Is the blue one in stock?",
    "Size M please",
  ]);

  // The conversation, found by the person, and its history a page at a time.
  await server.advanceClock(1_000);
  const conversations = await graph("GET", "me/conversations", {
    token,
    query: { platform: "instagram", user_id: customer.id },
  });
  expect(conversations.body.data.map((item) => item.id)).toEqual([
    first.conversation_id,
  ]);
  const history = [];
  let after;
  do {
    await server.advanceClock(1_000);
    const page = await graph("GET", `${first.conversation_id}/messages`, {
      token,
      query: {
        fields: "message,from",
        limit: "1",
        ...(after ? { after } : {}),
      },
    });
    history.push(...page.body.data);
    after = page.body.paging?.next ? page.body.paging.cursors.after : null;
  } while (after);
  expect(history.map((message) => message.message)).toEqual([
    "Size M please",
    "Is the blue one in stock?",
  ]);

  // The reply, then the person reads it.
  const reply = await graph("POST", "me/messages", {
    token,
    form: {
      recipient: JSON.stringify({ id: customer.id }),
      message: JSON.stringify({ text: "Yes, M is in stock." }),
    },
  });
  expect(reply.body).toEqual({
    recipient_id: customer.id,
    message_id: expect.any(String),
  });
  await server.markSeenByCustomer(shop.id, reply.body.message_id);
  expect(receiver.events.at(-1)).toMatchObject({
    sender: { id: customer.id },
    recipient: { id: shop.user_id },
    read: { mid: reply.body.message_id },
  });

  // The ledger: what the app called and every delivery, without secrets.
  const ledger = await server.getCalls();
  expect(
    ledger.calls.map((call) => [
      call.method,
      call.path.replace(/^\/v25\.0/, ""),
      call.status,
    ]),
  ).toEqual([
    ["GET", "/oauth/authorize", 302],
    ["POST", "/oauth/access_token", 200],
    ["GET", "/access_token", 200],
    ["GET", "/me", 200],
    ["POST", "/me/subscribed_apps", 200],
    ["GET", "/me/conversations", 200],
    ["GET", `/${first.conversation_id}/messages`, 200],
    ["GET", `/${first.conversation_id}/messages`, 200],
    ["POST", "/me/messages", 200],
  ]);
  expect(
    ledger.webhooks.map((attempt) => [attempt.field, attempt.status]),
  ).toEqual([
    ["messages", 200],
    ["messages", 200],
    ["messaging_seen", 200],
  ]);
  const serialized = JSON.stringify(ledger);
  for (const secret of [
    token,
    APP.secret,
    "Size M please",
    "Yes, M is in stock.",
  ]) {
    expect(serialized).not.toContain(secret);
  }
});
