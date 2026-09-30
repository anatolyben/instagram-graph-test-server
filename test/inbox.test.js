// A professional account's inbox: the Conversations API, the Send API's
// messaging rules, messaging webhooks, access state, time, faults and the
// calls ledger. Each case drives the server as an app does, over HTTP.
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { APP, cleanups, setup, startCallback } from "./helpers.js";

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// Seeded history from the last hour: older Requests conversations would
// fall under Meta's 30-day rule.
const START = Date.now() - HOUR;
const recent = (ms) => START + ms;

/**
 * A logged-in professional account subscribed to `fields`, with a recording
 * callback, and a Conversations API client that keeps to Meta's 2 calls a
 * second by moving the server's clock half a second before each call.
 */
async function inbox({ fields = "messages", username = "shop" } = {}) {
  const callback = await startCallback();
  const context = await setup({
    webhook: { callbackUrl: callback.url, verifyToken: callback.verifyToken },
  });
  const { server, graph } = context;
  const shop = await server.createAccount({ username });
  const token = (await context.login(shop.id)).long.access_token;
  if (fields) {
    const subscribed = await graph("POST", "me/subscribed_apps", {
      token,
      form: { subscribed_fields: fields },
    });
    expect(subscribed.body).toEqual({ success: true });
  }
  async function read(path, query = {}, as = token) {
    await server.advanceClock(500);
    return graph("GET", path, { token: as, query });
  }
  async function send(body, as = token) {
    return graph("POST", "me/messages", {
      token: as,
      form: Object.fromEntries(
        Object.entries(body).map(([key, value]) => [
          key,
          typeof value === "string" ? value : JSON.stringify(value),
        ]),
      ),
    });
  }
  const events = () =>
    callback.deliveries
      .flatMap((delivery) => delivery.body.entry)
      .flatMap((entry) => entry.messaging ?? []);
  return { ...context, callback, shop, token, read, send, events };
}

/** Walk every page of a listing by following `paging.next` cursors. */
async function allPages(read, path, query) {
  const pages = [];
  let after;
  for (;;) {
    const page = await read(path, { ...query, ...(after ? { after } : {}) });
    expect(page.status).toBe(200);
    pages.push(page.body);
    if (!page.body.paging?.next) return pages;
    after = page.body.paging.cursors.after;
  }
}

describe("conversations", () => {
  it("lists an account's conversations newest first, in pages", async () => {
    const { server, shop, read } = await inbox();
    const base = Date.parse("2026-09-01T00:00:00Z");
    const ids = [];
    for (let index = 0; index < 7; index += 1) {
      const conversation = await server.seedConversation(shop.id, {
        username: `customer${index}`,
        messages: [
          { from: "customer", text: `hi ${index}`, created_time: base + index },
        ],
      });
      ids.push(conversation.id);
    }
    const pages = await allPages(read, "me/conversations", {
      platform: "instagram",
      limit: "3",
    });
    expect(pages.map((page) => page.data.length)).toEqual([3, 3, 1]);
    expect(pages.flatMap((page) => page.data.map((item) => item.id))).toEqual(
      [...ids].reverse(),
    );
    expect(pages[0].data[0]).toEqual({
      id: ids[6],
      updated_time: "2026-09-01T00:00:00+0000",
    });
    expect(pages[0].paging.cursors).toEqual({
      before: expect.any(String),
      after: expect.any(String),
    });
    expect(pages.at(-1).paging.next).toBeUndefined();
  });

  it("answers empty, one-item and exact pages", async () => {
    const { server, shop, read } = await inbox();
    expect((await read("me/conversations")).body).toEqual({ data: [] });

    await server.seedConversation(shop.id, {
      username: "one",
      messages: [{ from: "customer", text: "hi", created_time: recent(1_000) }],
    });
    const single = await read("me/conversations", { limit: "2" });
    expect(single.body.data).toHaveLength(1);
    expect(single.body.paging.next).toBeUndefined();

    await server.seedConversation(shop.id, {
      username: "two",
      messages: [{ from: "customer", text: "hi", created_time: recent(2_000) }],
    });
    const pages = await allPages(read, "me/conversations", { limit: "2" });
    expect(pages.map((page) => page.data.length)).toEqual([2]);
  });

  it("orders conversations with equal times by id, the same on every read", async () => {
    const { server, shop, read } = await inbox();
    for (const id of ["30", "10", "20"]) {
      await server.seedConversation(shop.id, {
        id,
        username: `customer${id}`,
        messages: [
          { from: "customer", text: "same time", created_time: recent(5_000) },
        ],
      });
    }
    const first = await allPages(read, "me/conversations", { limit: "1" });
    const second = await allPages(read, "me/conversations", { limit: "2" });
    const order = (pages) =>
      pages.flatMap((page) => page.data.map((item) => item.id));
    expect(order(first)).toEqual(["30", "20", "10"]);
    expect(order(second)).toEqual(["30", "20", "10"]);
  });

  it("finds a person's conversation by user_id, and returns participants", async () => {
    const { server, shop, read } = await inbox();
    const customer = await server.createCustomer(shop.id, { username: "ana" });
    const conversation = await server.seedConversation(shop.id, {
      customer_id: customer.id,
      messages: [{ from: "customer", text: "hi", created_time: recent(1_000) }],
    });
    await server.seedConversation(shop.id, {
      username: "other",
      messages: [{ from: "customer", text: "hi", created_time: recent(2_000) }],
    });
    const found = await read("me/conversations", {
      user_id: customer.id,
      fields: "participants",
    });
    expect(found.body.data).toEqual([
      {
        id: conversation.id,
        participants: {
          data: [
            { username: "shop", id: shop.user_id },
            { username: "ana", id: customer.id },
          ],
        },
      },
    ]);
  });

  it("moves a conversation with a new message to the front; a cursor taken before does not repeat it", async () => {
    const { server, shop, read } = await inbox();
    const ids = [];
    for (let index = 0; index < 4; index += 1) {
      const conversation = await server.seedConversation(shop.id, {
        username: `customer${index}`,
        messages: [
          { from: "customer", text: "hi", created_time: recent(1_000 + index) },
        ],
      });
      ids.push(conversation.id);
    }
    const first = await read("me/conversations", { limit: "2" });
    expect(first.body.data.map((item) => item.id)).toEqual([ids[3], ids[2]]);

    // One already read and one not yet read both get a new message.
    await server.addConversationMessages(shop.id, ids[3], [
      { from: "customer", text: "again", created_time: recent(9_000) },
    ]);
    await server.addConversationMessages(shop.id, ids[0], [
      { from: "customer", text: "again", created_time: recent(9_001) },
    ]);
    const next = await read("me/conversations", {
      limit: "2",
      after: first.body.paging.cursors.after,
    });
    // Keyset paging: the cursor names a position, so what moved ahead of it
    // is not repeated and not reached until the listing is read again.
    expect(next.body.data.map((item) => item.id)).toEqual([ids[1]]);
    const fresh = await read("me/conversations", { limit: "2" });
    expect(fresh.body.data.map((item) => item.id)).toEqual([ids[0], ids[3]]);
  });

  it("stops returning a Requests conversation after 30 days without activity", async () => {
    const { server, shop, read } = await inbox();
    const { now } = await server.advanceClock(0);
    const request = await server.seedConversation(shop.id, {
      username: "stranger",
      folder: "requests",
      messages: [
        { from: "customer", text: "hello?", created_time: Date.parse(now) },
      ],
    });
    const general = await server.seedConversation(shop.id, {
      username: "regular",
      folder: "general",
      messages: [
        { from: "customer", text: "hello", created_time: Date.parse(now) - 1 },
      ],
    });
    expect(
      (await read("me/conversations")).body.data.map((item) => item.id),
    ).toEqual([request.id, general.id]);

    await server.advanceClock(30 * DAY + 1);
    expect(
      (await read("me/conversations")).body.data.map((item) => item.id),
    ).toEqual([general.id]);
    const gone = await read(request.id);
    expect(gone.body.error).toMatchObject({ code: 100, error_subcode: 33 });
  });

  it("moves a Requests conversation to General once the app answers", async () => {
    const { server, shop, send } = await inbox();
    const incoming = await server.sendMessageToAccount(shop.id, {
      username: "stranger",
      text: "hi",
    });
    expect(
      (await server.getConversation(shop.id, incoming.conversation_id)).folder,
    ).toBe("requests");
    const reply = await send({
      recipient: { id: incoming.person_id },
      message: { text: "Hello!" },
    });
    expect(reply.status).toBe(200);
    expect(
      (await server.getConversation(shop.id, incoming.conversation_id)).folder,
    ).toBe("general");
  });
});

describe("messages in a conversation", () => {
  async function longConversation(count) {
    const context = await inbox();
    const base = Date.parse("2026-09-10T12:00:00Z");
    const conversation = await context.server.seedConversation(
      context.shop.id,
      {
        username: "ana",
        messages: Array.from({ length: count }, (_, index) => ({
          id: `m${String(index).padStart(2, "0")}`,
          from: index % 2 ? "business" : "customer",
          text: `message ${index}`,
          created_time: base + index * 1_000,
        })),
      },
    );
    return { ...context, conversation, base };
  }

  it("pages a conversation's messages newest first across three pages", async () => {
    const { read, conversation } = await longConversation(7);
    const pages = await allPages(read, `${conversation.id}/messages`, {
      limit: "3",
    });
    expect(pages.map((page) => page.data.length)).toEqual([3, 3, 1]);
    expect(pages.flatMap((page) => page.data.map((item) => item.id))).toEqual([
      "m06",
      "m05",
      "m04",
      "m03",
      "m02",
      "m01",
      "m00",
    ]);
    expect(pages[0].data[0]).toEqual({
      id: "m06",
      created_time: "2026-09-10T12:00:06+0000",
    });
  });

  it("returns the first page of messages as a conversation field", async () => {
    const { read, conversation } = await longConversation(4);
    const view = await read(conversation.id, { fields: "messages" });
    expect(view.body.id).toBe(conversation.id);
    expect(view.body.messages.data.map((item) => item.id)).toEqual([
      "m03",
      "m02",
      "m01",
      "m00",
    ]);
  });

  it("reads a message's fields, and details only for the 20 most recent", async () => {
    const { read, conversation, shop } = await longConversation(22);
    const recent = await read("m21", {
      fields: "id,created_time,from,to,message",
    });
    expect(recent.body).toEqual({
      id: "m21",
      created_time: "2026-09-10T12:00:21+0000",
      from: { username: "shop", id: shop.user_id },
      to: { data: [{ username: "ana", id: conversation.customer_id }] },
      message: "message 21",
    });
    const old = await read("m01", { fields: "message" });
    expect(old.body.error).toMatchObject({
      code: 9000001,
      message: "This Message has been deleted by the user or the business.",
    });
    // Every message id is listed, old ones without their details.
    const pages = await allPages(read, `${conversation.id}/messages`, {
      limit: "25",
      fields: "id,message",
    });
    const listed = pages[0].data;
    expect(listed).toHaveLength(22);
    expect(listed[0]).toEqual({ id: "m21", message: "message 21" });
    expect(listed.at(-1)).toEqual({ id: "m00" });
  });

  it("does not repeat or skip older messages when new ones arrive between pages", async () => {
    const { server, read, conversation, shop } = await longConversation(5);
    const first = await read(`${conversation.id}/messages`, { limit: "2" });
    await server.addConversationMessages(shop.id, conversation.id, [
      { id: "new", from: "customer", text: "late", created_time: Date.now() },
    ]);
    const rest = await allPages(read, `${conversation.id}/messages`, {
      limit: "2",
      after: first.body.paging.cursors.after,
    });
    expect([
      ...first.body.data.map((item) => item.id),
      ...rest.flatMap((page) => page.data.map((item) => item.id)),
    ]).toEqual(["m04", "m03", "m02", "m01", "m00"]);
  });

  it("answers an unsent message as deleted and leaves it out of the list", async () => {
    const { server, read, shop } = await inbox();
    const incoming = await server.sendMessageToAccount(shop.id, {
      username: "ana",
      text: "oops",
    });
    await server.deleteMessage(shop.id, incoming.mid);
    const gone = await read(incoming.mid, { fields: "message" });
    expect(gone.body.error).toMatchObject({ code: 9000001 });
    const listed = await read(`${incoming.conversation_id}/messages`);
    expect(listed.body).toEqual({ data: [] });
  });
});

describe("what a person sends", () => {
  it("delivers every modelled attachment and event in Meta's webhook shapes", async () => {
    const { server, shop, send, events } = await inbox({
      fields:
        "messages,messaging_seen,messaging_postbacks,messaging_referral,message_edit,message_reactions",
    });
    const customer = await server.createCustomer(shop.id, { username: "ana" });
    const say = (fields) =>
      server.sendMessageToAccount(shop.id, {
        person_id: customer.id,
        ...fields,
      });
    const text = await say({ text: "hello" });
    await say({
      attachments: [
        { type: "image", url: "https://cdn.test/a.jpg" },
        { type: "video", url: "https://cdn.test/a.mp4" },
        { type: "audio", url: "https://cdn.test/a.m4a" },
        { type: "file", url: "https://cdn.test/a.pdf" },
      ],
    });
    await say({
      attachments: [
        {
          type: "ig_post",
          url: "https://cdn.test/post",
          ig_post_media_id: "1790001",
          title: "A post",
        },
      ],
    });
    await say({
      attachments: [
        {
          type: "ig_reel",
          url: "https://cdn.test/reel",
          reel_video_id: "1790002",
          title: "A reel",
        },
      ],
    });
    await say({
      attachments: [{ type: "story_mention", url: "https://cdn.test/story" }],
    });
    await say({ attachments: [{ type: "ephemeral" }] });
    await say({
      text: "love this",
      reply_to_story: { id: "1790003", url: "https://cdn.test/story2" },
    });
    await say({ is_unsupported: true });

    const reply = await send({
      recipient: { id: customer.id },
      message: { text: "Thanks" },
    });
    await server.markSeenByCustomer(shop.id, reply.body.message_id);
    await server.editMessage(shop.id, text.mid, "hello there");
    await server.sendPostback(shop.id, {
      person_id: customer.id,
      title: "Track my order",
      payload: "TRACK",
    });
    await server.sendReferral(shop.id, {
      person_id: customer.id,
      ref: "summer",
      source: "IGME",
    });
    await server.reactToMessage(shop.id, reply.body.message_id, {
      reaction: "love",
      emoji: "❤️",
    });

    const received = events();
    const messages = received.filter((event) => event.message);
    expect(messages.map((event) => event.message)).toEqual([
      { mid: text.mid, text: "hello" },
      {
        mid: expect.any(String),
        attachments: [
          { type: "image", payload: { url: "https://cdn.test/a.jpg" } },
          { type: "video", payload: { url: "https://cdn.test/a.mp4" } },
          { type: "audio", payload: { url: "https://cdn.test/a.m4a" } },
          { type: "file", payload: { url: "https://cdn.test/a.pdf" } },
        ],
      },
      {
        mid: expect.any(String),
        attachments: [
          {
            type: "ig_post",
            payload: {
              ig_post_media_id: "1790001",
              title: "A post",
              url: "https://cdn.test/post",
            },
          },
        ],
      },
      {
        mid: expect.any(String),
        attachments: [
          {
            type: "ig_reel",
            payload: {
              reel_video_id: "1790002",
              title: "A reel",
              url: "https://cdn.test/reel",
            },
          },
        ],
      },
      {
        mid: expect.any(String),
        attachments: [
          { type: "story_mention", payload: { url: "https://cdn.test/story" } },
        ],
      },
      { mid: expect.any(String), attachments: [{ type: "ephemeral" }] },
      {
        mid: expect.any(String),
        text: "love this",
        reply_to: { story: { url: "https://cdn.test/story2", id: "1790003" } },
      },
      { mid: expect.any(String), is_unsupported: true },
    ]);
    const other = received.filter((event) => !event.message);
    expect(other.map((event) => Object.keys(event).sort())).toEqual([
      ["read", "recipient", "sender", "timestamp"],
      ["message_edit", "recipient", "sender", "timestamp"],
      ["postback", "recipient", "sender", "timestamp"],
      ["recipient", "referral", "sender", "timestamp"],
      ["reaction", "recipient", "sender", "timestamp"],
    ]);
    expect(other[0].read).toEqual({ mid: reply.body.message_id });
    expect(other[1].message_edit).toEqual({
      mid: text.mid,
      text: "hello there",
      num_edit: 1,
    });
    expect(other[2].postback).toEqual({
      mid: expect.any(String),
      title: "Track my order",
      payload: "TRACK",
    });
    expect(other[3].referral).toEqual({
      ref: "summer",
      source: "IGME",
      type: "OPEN_THREAD",
    });
    for (const event of received) {
      expect(event.sender.id === customer.id).toBe(true);
      expect(event.recipient).toEqual({ id: shop.user_id });
    }
  });

  it("returns attachments, shares, story mentions, replies and reactions through the Conversations API", async () => {
    const { server, shop, read } = await inbox();
    const conversation = await server.seedConversation(shop.id, {
      username: "ana",
      messages: [
        {
          id: "photo",
          from: "customer",
          created_time: recent(1_000),
          attachments: [{ type: "image", url: "https://cdn.test/a.jpg" }],
          reactions: [{ by: "business", reaction: "love", emoji: "❤️" }],
        },
        {
          id: "clip",
          from: "customer",
          created_time: recent(2_000),
          attachments: [{ type: "video", url: "https://cdn.test/a.mp4" }],
        },
        {
          id: "doc",
          from: "customer",
          created_time: recent(3_000),
          attachments: [{ type: "file", url: "https://cdn.test/a.pdf" }],
        },
        {
          id: "post",
          from: "customer",
          created_time: recent(4_000),
          attachments: [
            {
              type: "ig_post",
              url: "https://cdn.test/post",
              ig_post_media_id: "1790001",
              title: "A post",
            },
          ],
        },
        {
          id: "mention",
          from: "customer",
          created_time: recent(5_000),
          attachments: [
            {
              type: "story_mention",
              url: "https://cdn.test/story",
              story_id: "1790009",
            },
          ],
        },
        {
          id: "answer",
          from: "business",
          text: "Nice photo",
          created_time: recent(6_000),
          reply_to: "photo",
        },
        {
          id: "odd",
          from: "customer",
          created_time: recent(7_000),
          is_unsupported: true,
        },
      ],
    });
    const photo = await read("photo", { fields: "attachments,reactions" });
    expect(photo.body).toEqual({
      id: "photo",
      attachments: {
        data: [
          {
            id: expect.any(String),
            image_data: {
              url: "https://cdn.test/a.jpg",
              preview_url: "https://cdn.test/a.jpg",
              width: 1080,
              height: 1080,
              max_width: 1080,
              max_height: 1080,
              render_as_sticker: false,
            },
          },
        ],
      },
      reactions: {
        data: [
          {
            reaction: "❤️",
            users: [{ username: "shop", id: shop.user_id }],
          },
        ],
      },
    });
    expect((await read("clip", { fields: "attachments" })).body).toEqual({
      id: "clip",
      attachments: {
        data: [
          {
            id: expect.any(String),
            video_data: {
              url: "https://cdn.test/a.mp4",
              preview_url: "https://cdn.test/a.mp4",
            },
          },
        ],
      },
    });
    expect((await read("doc", { fields: "attachments" })).body).toEqual({
      id: "doc",
      attachments: {
        data: [{ id: expect.any(String), file_url: "https://cdn.test/a.pdf" }],
      },
    });
    expect(
      (await read("post", { fields: "shares{type,url,id}" })).body,
    ).toEqual({
      id: "post",
      shares: {
        data: [
          { type: "ig_post", url: "https://cdn.test/post", id: "1790001" },
        ],
      },
    });
    expect((await read("mention", { fields: "story" })).body).toEqual({
      id: "mention",
      story: { mention: { link: "https://cdn.test/story", id: "1790009" } },
    });
    expect((await read("answer", { fields: "message,reply_to" })).body).toEqual(
      {
        id: "answer",
        message: "Nice photo",
        reply_to: { mid: "photo", is_self_reply: false },
      },
    );
    expect(
      (await read("odd", { fields: "message,is_unsupported" })).body,
    ).toEqual({ id: "odd", message: "", is_unsupported: true });
    expect(conversation.messages).toHaveLength(7);
  });
});

describe("webhook deliveries", () => {
  function signatureOf(raw) {
    return `sha256=${createHmac("sha256", APP.secret).update(raw).digest("hex")}`;
  }

  it("signs every delivery, and can resend one unsigned or wrongly signed", async () => {
    const { server, shop, callback } = await inbox();
    const incoming = await server.sendMessageToAccount(shop.id, {
      username: "ana",
      text: "hi",
    });
    const [first] = callback.deliveries;
    expect(first.headers["x-hub-signature-256"]).toBe(signatureOf(first.raw));

    await server.redeliverWebhook(incoming.webhook.id, {
      signature: "missing",
    });
    await server.redeliverWebhook(incoming.webhook.id, {
      signature: "invalid",
    });
    const [, missing, invalid] = callback.deliveries;
    expect(missing.raw.equals(first.raw)).toBe(true);
    expect(missing.headers["x-hub-signature-256"]).toBeUndefined();
    expect(invalid.raw.equals(first.raw)).toBe(true);
    expect(invalid.headers["x-hub-signature-256"]).toMatch(
      /^sha256=[0-9a-f]{64}$/,
    );
    expect(invalid.headers["x-hub-signature-256"]).not.toBe(
      signatureOf(invalid.raw),
    );
  });

  it("repeats a delivery without creating another message", async () => {
    const { server, shop, callback } = await inbox();
    const incoming = await server.sendMessageToAccount(shop.id, {
      username: "ana",
      text: "hi",
    });
    await server.redeliverWebhook(incoming.webhook.id);
    expect(callback.deliveries).toHaveLength(2);
    expect(callback.deliveries[1].raw.equals(callback.deliveries[0].raw)).toBe(
      true,
    );
    const conversation = await server.getConversation(
      shop.id,
      incoming.conversation_id,
    );
    expect(conversation.messages.map((message) => message.id)).toEqual([
      incoming.mid,
    ]);
  });

  it("holds deliveries and releases them out of order, each with its own timestamp", async () => {
    const { server, shop, callback, events } = await inbox();
    await server.holdWebhooks();
    const first = await server.sendMessageToAccount(shop.id, {
      username: "ana",
      text: "first",
    });
    await server.advanceClock(1_000);
    const second = await server.sendMessageToAccount(shop.id, {
      person_id: first.person_id,
      text: "second",
    });
    expect(first.webhook.held).toBe(true);
    expect(callback.deliveries).toHaveLength(0);

    await server.releaseWebhooks({ order: "reverse" });
    await expect.poll(() => callback.deliveries.length).toBe(2);
    const [late, early] = events();
    expect([late.message.mid, early.message.mid]).toEqual([
      second.mid,
      first.mid,
    ]);
    expect(late.timestamp - early.timestamp).toBe(1_000);
  });

  it("sends messaging webhooks only for a Live app, and under Standard Access only about people with a role on it", async () => {
    const { server, shop } = await inbox();
    await server.setAppAccess({ mode: "development" });
    const offline = await server.sendMessageToAccount(shop.id, {
      username: "ana",
      text: "hi",
    });
    expect(offline.webhook.skipped).toBe("the app is not Live");

    await server.setAppAccess({ mode: "live", access_level: "standard" });
    const stranger = await server.sendMessageToAccount(shop.id, {
      username: "bob",
      text: "hi",
    });
    expect(stranger.webhook.skipped).toBe(
      "Standard Access: the person has no role on the app",
    );
    const tester = await server.createCustomer(shop.id, {
      username: "tester",
      has_app_role: true,
    });
    const allowed = await server.sendMessageToAccount(shop.id, {
      person_id: tester.id,
      text: "hi",
    });
    expect(allowed.webhook.delivered).toBe(true);
  });

  it("sends nothing for a field the account has not subscribed to", async () => {
    const { server, shop, send } = await inbox({ fields: "messages" });
    const incoming = await server.sendMessageToAccount(shop.id, {
      username: "ana",
      text: "hi",
    });
    const reply = await send({
      recipient: { id: incoming.person_id },
      message: { text: "hello" },
    });
    const seen = await server.markSeenByCustomer(
      shop.id,
      reply.body.message_id,
    );
    expect(seen.webhook.skipped).toBe(
      "account is not subscribed to messaging_seen",
    );
  });
});

describe("sending", () => {
  it("answers inside 24 hours of the person's last message, and refuses after", async () => {
    const { server, shop, send } = await inbox();
    const incoming = await server.sendMessageToAccount(shop.id, {
      username: "ana",
      text: "hi",
    });
    await server.advanceClock(DAY - 1_000);
    const inside = await send({
      recipient: { id: incoming.person_id },
      message: { text: "still here" },
    });
    expect(inside.body).toEqual({
      recipient_id: incoming.person_id,
      message_id: expect.any(String),
    });
    await server.advanceClock(2_000);
    const outside = await send({
      recipient: { id: incoming.person_id },
      message: { text: "too late" },
    });
    expect(outside.body.error).toMatchObject({
      code: 10,
      error_subcode: 2534022,
    });
    const conversation = await server.getConversation(
      shop.id,
      incoming.conversation_id,
    );
    expect(conversation.messages.map((message) => message.text)).toEqual([
      "hi",
      "still here",
    ]);
  });

  it("allows the Human Agent tag for 7 days, only when the feature is approved", async () => {
    const { server, shop, send } = await inbox();
    const incoming = await server.sendMessageToAccount(shop.id, {
      username: "ana",
      text: "hi",
    });
    await server.advanceClock(3 * DAY);
    const tagged = {
      recipient: { id: incoming.person_id },
      messaging_type: "MESSAGE_TAG",
      tag: "HUMAN_AGENT",
      message: { text: "An agent here" },
    };
    const unapproved = await send(tagged);
    expect(unapproved.status).toBe(403);
    expect(unapproved.body.error).toMatchObject({ code: 10 });

    await server.setAppAccess({ human_agent: true });
    expect((await send(tagged)).status).toBe(200);
    const otherTag = await send({ ...tagged, tag: "ACCOUNT_UPDATE" });
    expect(otherTag.body.error).toMatchObject({ code: 100 });

    await server.advanceClock(4 * DAY + 1_000);
    const late = await send(tagged);
    expect(late.body.error).toMatchObject({ code: 10, error_subcode: 2534022 });
  });

  it("shows typing, marks seen and reacts with sender actions, which send no echo", async () => {
    const { server, shop, send, read, callback } = await inbox({
      fields: "messages,message_echoes",
    });
    const incoming = await server.sendMessageToAccount(shop.id, {
      username: "ana",
      text: "hi",
    });
    for (const action of ["typing_on", "typing_off", "mark_seen"]) {
      const answer = await send({
        recipient: { id: incoming.person_id },
        sender_action: action,
      });
      expect(answer.body).toEqual({ recipient_id: incoming.person_id });
    }
    const react = await send({
      recipient: { id: incoming.person_id },
      sender_action: "react",
      payload: { message_id: incoming.mid, reaction: "love" },
    });
    expect(react.body).toEqual({ recipient_id: incoming.person_id });
    const mixed = await send({
      recipient: { id: incoming.person_id },
      sender_action: "typing_on",
      message: { text: "hi" },
    });
    expect(mixed.body.error).toMatchObject({ code: 100 });

    const conversation = await server.getConversation(
      shop.id,
      incoming.conversation_id,
    );
    expect(conversation.messages[0].seen_by_business).toBe(true);
    expect(
      (await read(incoming.mid, { fields: "reactions" })).body.reactions,
    ).toEqual({
      data: [
        { reaction: "❤️", users: [{ username: "shop", id: shop.user_id }] },
      ],
    });
    expect(callback.deliveries).toHaveLength(1);
  });

  it("makes the send and drops the answer when told to, leaving the outcome to the app to find", async () => {
    const { server, shop, send, read } = await inbox();
    const incoming = await server.sendMessageToAccount(shop.id, {
      username: "ana",
      text: "hi",
    });
    await server.addFault({ method: "POST", path: "/messages$", drop: true });
    await expect(
      send({
        recipient: { id: incoming.person_id },
        message: { text: "Did this arrive?" },
      }),
    ).rejects.toThrow();
    const listed = await read(`${incoming.conversation_id}/messages`, {
      fields: "message",
    });
    expect(listed.body.data.map((item) => item.message)).toEqual([
      "Did this arrive?",
      "hi",
    ]);
  });
});

describe("access", () => {
  it("refuses conversations without the messages permission, and again once it is granted back", async () => {
    const { server, shop, read } = await inbox();
    await server.setPermissions(shop.id, {
      revoke: ["instagram_business_manage_messages"],
    });
    const refused = await read("me/conversations");
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatchObject({ code: 10 });
    await server.setPermissions(shop.id, {
      grant: ["instagram_business_manage_messages"],
    });
    expect((await read("me/conversations")).status).toBe(200);
  });

  it("under Standard Access lists and messages only people with a role on the app", async () => {
    const { server, shop, read, send } = await inbox();
    const stranger = await server.sendMessageToAccount(shop.id, {
      username: "stranger",
      text: "hi",
    });
    const tester = await server.createCustomer(shop.id, {
      username: "tester",
      has_app_role: true,
    });
    const withTester = await server.sendMessageToAccount(shop.id, {
      person_id: tester.id,
      text: "hi",
    });
    await server.setAppAccess({ access_level: "standard" });
    expect(
      (await read("me/conversations")).body.data.map((item) => item.id),
    ).toEqual([withTester.conversation_id]);
    const refused = await send({
      recipient: { id: stranger.person_id },
      message: { text: "hello" },
    });
    expect(refused.body.error).toMatchObject({ code: 200 });
    expect(
      (
        await send({
          recipient: { id: tester.id },
          message: { text: "hello" },
        })
      ).status,
    ).toBe(200);
  });

  it("grants Advanced Access and the Human Agent feature only to a verified business", async () => {
    const { server } = await inbox();
    await server.setAppAccess({
      access_level: "standard",
      business_verified: false,
    });
    await expect(
      server.setAppAccess({ access_level: "advanced" }),
    ).rejects.toThrow(/Business Verification/);
    await expect(server.setAppAccess({ human_agent: true })).rejects.toThrow(
      /Business Verification/,
    );
    expect(await server.getAppAccess()).toEqual({
      mode: "live",
      access_level: "standard",
      business_verified: false,
      human_agent: false,
    });
  });

  it("answers an expired token with Meta's token error", async () => {
    const { server, shop, read } = await inbox();
    await server.advanceClock(61 * DAY);
    const expired = await read("me/conversations");
    expect(expired.body.error).toMatchObject({ code: 190, error_subcode: 463 });
    expect(shop.id).toBeDefined();
  });

  it("creates only professional accounts", async () => {
    const { server } = await inbox();
    await expect(
      server.createAccount({ username: "me", account_type: "PERSONAL" }),
    ).rejects.toThrow(/BUSINESS or MEDIA_CREATOR/);
  });
});

describe("isolation between accounts", () => {
  it("keeps colliding conversation and message ids apart, in reads, controls and cursors", async () => {
    const one = await inbox({ username: "one" });
    const { server } = one;
    const two = await server.createAccount({ username: "two" });
    const twoToken = (await one.login(two.id)).long.access_token;
    for (const [account, text] of [
      [one.shop, "for one"],
      [two, "for two"],
    ]) {
      await server.createCustomer(account.id, { id: "900", username: "ana" });
      await server.seedConversation(account.id, {
        id: "c1",
        customer_id: "900",
        messages: [
          { id: "m1", from: "customer", text, created_time: recent(1_000) },
          { id: "m2", from: "customer", text, created_time: recent(2_000) },
        ],
      });
    }
    expect((await one.read("m1", { fields: "message" })).body.message).toBe(
      "for one",
    );
    expect(
      (await one.read("m1", { fields: "message" }, twoToken)).body.message,
    ).toBe("for two");
    expect((await server.getConversation(two.id, "c1")).messages[0].text).toBe(
      "for two",
    );

    const page = await one.read("c1/messages", { limit: "1" });
    const cursor = page.body.paging.cursors.after;
    const elsewhere = await one.read(
      "c1/messages",
      { limit: "1", after: cursor },
      twoToken,
    );
    expect(elsewhere.body.error).toMatchObject({ code: 100 });
    const otherCollection = await one.read("me/conversations", {
      after: cursor,
    });
    expect(otherCollection.body.error).toMatchObject({ code: 100 });
    const forged = await one.read("c1/messages", { after: "bm90LWEtY3Vyc29y" });
    expect(forged.body.error).toMatchObject({ code: 100 });

    await server.deleteMessage(two.id, "m1");
    expect((await one.read("m1", { fields: "message" })).body.message).toBe(
      "for one",
    );
  });

  it("scopes a person's id to the account they message", async () => {
    const one = await inbox({ username: "one" });
    const two = await one.server.createAccount({ username: "two" });
    const twoToken = (await one.login(two.id)).long.access_token;
    const incoming = await one.server.sendMessageToAccount(one.shop.id, {
      username: "ana",
      text: "hi",
    });
    const fromTwo = await one.send(
      { recipient: { id: incoming.person_id }, message: { text: "hello" } },
      twoToken,
    );
    expect(fromTwo.body.error).toMatchObject({
      code: 100,
      error_subcode: 2534014,
    });
  });
});

describe("rate limits and failures", () => {
  it("allows the Conversations API 2 calls a second per account", async () => {
    const { server, graph, token } = await inbox();
    const call = () => graph("GET", "me/conversations", { token });
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    const third = await call();
    expect(third.body.error).toMatchObject({ code: 613 });
    expect(third.headers.get("x-business-use-case-usage")).toBeTruthy();
    await server.advanceClock(1_000);
    expect((await call()).status).toBe(200);
  });

  it("fails one page with an injected 5xx, and serves it on retry", async () => {
    const { server, shop, read } = await inbox();
    for (let index = 0; index < 3; index += 1) {
      await server.seedConversation(shop.id, {
        username: `customer${index}`,
        messages: [
          { from: "customer", text: "hi", created_time: recent(1_000 + index) },
        ],
      });
    }
    const first = await read("me/conversations", { limit: "2" });
    await server.addFault({
      method: "GET",
      path: "/conversations$",
      status: 503,
      code: 2,
    });
    const next = { limit: "2", after: first.body.paging.cursors.after };
    const failed = await read("me/conversations", next);
    expect(failed.status).toBe(503);
    expect(failed.body.error).toMatchObject({ code: 2 });
    expect((await read("me/conversations", next)).body.data).toHaveLength(1);
  });

  it("fails closed on folders, platforms, fields and edges it does not model", async () => {
    const { server, shop, read } = await inbox();
    const conversation = await server.seedConversation(shop.id, {
      username: "ana",
      messages: [
        { id: "m1", from: "customer", text: "hi", created_time: recent(1) },
      ],
    });
    for (const [path, query] of [
      ["me/conversations", { folder: "inbox" }],
      ["me/conversations", { platform: "messenger" }],
      ["me/conversations", { fields: "id,unread_count" }],
      [conversation.id, { fields: "labels" }],
      ["m1", { fields: "tags" }],
      [`${conversation.id}/participants`, {}],
    ]) {
      const answer = await read(path, query);
      expect(
        answer.body.error,
        `${path} ${JSON.stringify(query)}`,
      ).toMatchObject({ code: 100 });
    }
  });
});

describe("attachment URLs", () => {
  it("serves a person's attachment until it expires, and never after it is unsent", async () => {
    const { server, shop } = await inbox();
    const photo = await server.sendMessageToAccount(shop.id, {
      username: "ana",
      attachments: [{ type: "image", expires_in_ms: HOUR }],
    });
    const url = photo.attachments[0].url;
    expect(new URL(url).origin).toBe(server.origin);
    expect((await fetch(url)).status).toBe(200);
    await server.advanceClock(HOUR + 1);
    expect((await fetch(url)).status).toBe(403);

    const again = await server.sendMessageToAccount(shop.id, {
      person_id: photo.person_id,
      attachments: [{ type: "image" }],
    });
    const second = again.attachments[0].url;
    expect((await fetch(second)).status).toBe(200);
    await server.deleteMessage(shop.id, again.mid);
    expect((await fetch(second)).status).toBe(404);

    const broken = await server.sendMessageToAccount(shop.id, {
      person_id: photo.person_id,
      attachments: [{ type: "image", unavailable: true }],
    });
    expect((await fetch(broken.attachments[0].url)).status).toBe(404);
  });
});

describe("the calls ledger", () => {
  it("records Graph calls and webhook attempts without tokens, signatures or content", async () => {
    const { server, shop, read, send, token } = await inbox();
    const incoming = await server.sendMessageToAccount(shop.id, {
      username: "ana",
      text: "my secret address",
    });
    await send({
      recipient: { id: incoming.person_id },
      message: { text: "private reply text" },
    });
    await read(`${incoming.conversation_id}/messages`, { fields: "message" });
    const ledger = await server.getCalls();
    const serialized = JSON.stringify(ledger);
    for (const secret of [
      token,
      "my secret address",
      "private reply text",
      APP.secret,
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(ledger.calls.at(-1)).toMatchObject({
      method: "GET",
      path: `/v25.0/${incoming.conversation_id}/messages`,
      params: ["fields"],
      status: 200,
    });
    expect(ledger.webhooks).toEqual([
      {
        delivery_id: incoming.webhook.id,
        field: "messages",
        account_id: shop.user_id,
        at: expect.any(String),
        status: 200,
        signature: "valid",
      },
    ]);
  });
});

describe("resetting messaging", () => {
  it("clears conversations, people's messages and held webhooks, and keeps accounts and tokens", async () => {
    const { server, shop, read } = await inbox();
    const seed = () =>
      server.seedConversation(shop.id, {
        id: "c1",
        customer_id: "900",
        messages: [
          { id: "m1", from: "customer", text: "hi", created_time: recent(1) },
        ],
      });
    await server.createCustomer(shop.id, { id: "900", username: "ana" });
    await seed();
    await server.resetMessaging();
    expect((await read("me/conversations")).body).toEqual({ data: [] });
    expect(await server.getConversations(shop.id)).toEqual([]);
    expect((await server.getAccount(shop.id)).username).toBe("shop");
    // The same ids can be seeded again.
    await server.createCustomer(shop.id, { id: "900", username: "ana" });
    expect((await seed()).messages.map((message) => message.id)).toEqual([
      "m1",
    ]);
  });
});
