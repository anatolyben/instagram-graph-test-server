import http from "node:http";
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { startTestServer } from "../src/index.js";

const APP = {
  id: "1234567890",
  secret: "test-app-secret",
  redirectUris: ["http://localhost:4000/instagram/callback"],
};
const SCOPES = [
  "instagram_business_basic",
  "instagram_business_manage_comments",
  "instagram_business_content_publish",
  "instagram_business_manage_messages",
];

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

/** A webhook callback that answers Meta's handshake and records deliveries. */
async function startCallback({ verifyToken = "verify-me", status = 200 } = {}) {
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

async function setup(options = {}) {
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

describe("Instagram Business Login", () => {
  it("exchanges a code for a short-lived token, then a long-lived one", async () => {
    const { server, login } = await setup();
    const account = await server.createAccount({ username: "shop" });

    const { state, short, long } = await login(account.id);

    expect(state).toBe("xyz");
    // user_id is the professional account id, which webhooks also use.
    expect(short).toMatchObject({
      user_id: account.user_id,
      permissions: SCOPES.join(","),
    });
    expect(long).toMatchObject({
      token_type: "bearer",
      expires_in: expect.any(Number),
    });
  });

  it("refuses to refresh a token less than a day old, and refreshes an older one", async () => {
    const { server, login } = await setup();
    const account = await server.createAccount({ username: "shop" });
    const { long } = await login(account.id);
    const refresh = () =>
      fetch(
        new URL(
          `/refresh_access_token?grant_type=ig_refresh_token&access_token=${long.access_token}`,
          server.origin,
        ),
      );

    expect((await refresh()).status).toBe(400);
    await server.changeTokens(account.id, { age_hours: 25 });
    expect(await (await refresh()).json()).toMatchObject({
      token_type: "bearer",
    });
  });

  it("answers Meta's token errors: missing, unparseable, revoked and expired", async () => {
    const { server, graph, login } = await setup();
    const account = await server.createAccount({ username: "shop" });
    const { long } = await login(account.id);

    const missing = await graph("GET", "me");
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatchObject({
      type: "IGApiException",
      code: 190,
      error_data: {},
    });
    expect(missing.headers.get("www-authenticate")).toContain(
      "invalid_request",
    );

    expect(
      (await graph("GET", "me", { token: "garbage" })).body.error,
    ).toMatchObject({
      type: "OAuthException",
      code: 190,
    });

    await server.changeTokens(account.id, { revoke: true });
    expect(
      (await graph("GET", "me", { token: long.access_token })).body.error,
    ).toMatchObject({
      code: 190,
      error_subcode: 458,
    });

    const other = await server.createAccount({ username: "second" });
    const second = (await login(other.id)).long.access_token;
    await server.changeTokens(other.id, { logout: true });
    expect(
      (await graph("GET", "me", { token: second })).body.error,
    ).toMatchObject({
      code: 190,
      error_subcode: 460,
    });
  });

  it("grants only the scopes the person approved", async () => {
    const { server, graph, login } = await setup();
    const account = await server.createAccount({ username: "shop" });
    const { long } = await login(account.id, ["instagram_business_basic"]);
    const media = await server.postMedia(account.id);

    const listed = await graph("GET", `${media.id}/comments`, {
      token: long.access_token,
    });
    expect(listed.status).toBe(403);
    expect(listed.body.error.code).toBe(10);
  });
});

describe("comments", () => {
  async function withComment(options) {
    const context = await setup(options);
    const account = await context.server.createAccount({ username: "shop" });
    const { long } = await context.login(account.id);
    const media = await context.server.postMedia(account.id, {
      caption: "New drop",
    });
    const comment = await context.server.comment(media.id, {
      username: "spammer",
      text: "cheap followers at example.com",
    });
    return { ...context, account, token: long.access_token, media, comment };
  }

  it("reads, hides, unhides and deletes a comment, and records who did it", async () => {
    const { server, graph, token, comment } = await withComment();

    const read = await graph("GET", comment.id, {
      token,
      query: { fields: "text,hidden,from" },
    });
    expect(read.body).toMatchObject({
      id: comment.id,
      hidden: false,
      from: { username: "spammer" },
    });

    await graph("POST", comment.id, { token, query: { hide: "true" } });
    expect((await server.getComment(comment.id)).hidden).toBe(true);

    await graph("POST", comment.id, { token, query: { hide: "false" } });
    await graph("DELETE", comment.id, { token });
    const final = await server.getComment(comment.id);
    expect(final.deleted).toBe(true);
    expect(final.history.map((entry) => entry.action)).toEqual([
      "created",
      "hidden",
      "unhidden",
      "deleted",
    ]);
  });

  it("reads hide only from the query string, as Meta does", async () => {
    const { server, graph, token, comment } = await withComment();

    const bodyOnly = await graph("POST", comment.id, {
      token,
      form: { hide: "true" },
    });

    expect(bodyOnly.status).toBe(400);
    expect((await server.getComment(comment.id)).hidden).toBe(false);
  });

  it("leaves the media owner's own comment visible when asked to hide it", async () => {
    const { server, graph, token, media } = await withComment();
    const own = await server.comment(media.id, {
      as_owner: true,
      text: "Thanks all",
    });

    expect(
      (await graph("POST", own.id, { token, query: { hide: "true" } })).body,
    ).toEqual({
      success: true,
    });
    expect((await server.getComment(own.id)).hidden).toBe(false);
  });

  it("threads replies one level deep", async () => {
    const { server, graph, token, media, comment } = await withComment();
    const reply = await server.comment(media.id, {
      username: "other",
      text: "reply to the spam",
      parent_id: comment.id,
    });

    const nested = await server.comment(media.id, {
      username: "third",
      text: "reply to the reply",
      parent_id: reply.id,
    });

    expect(nested.parent_id).toBe(comment.id);
    const replies = await graph("GET", `${comment.id}/replies`, { token });
    expect(replies.body.data.map((item) => item.id)).toEqual([
      reply.id,
      nested.id,
    ]);
  });

  it("pages through comments with Meta's cursors", async () => {
    const { server, graph, token, media } = await withComment();
    for (const text of ["one", "two", "three"]) {
      await server.comment(media.id, { username: "fan", text });
    }

    const first = await graph("GET", `${media.id}/comments`, {
      token,
      query: { limit: "2" },
    });
    expect(first.body.data).toHaveLength(2);
    expect(first.body.paging.next).toBeTruthy();
    const second = await graph("GET", `${media.id}/comments`, {
      token,
      query: { limit: "2", after: first.body.paging.cursors.after },
    });
    expect(second.body.data).toHaveLength(2);
  });
});

describe("webhooks", () => {
  it("verifies the callback, then delivers signed comment events to subscribed accounts", async () => {
    const callback = await startCallback();
    const { server, graph, login } = await setup({
      webhook: { callbackUrl: callback.url, verifyToken: callback.verifyToken },
    });
    const account = await server.createAccount({ username: "shop" });
    const { long } = await login(account.id);
    await graph("POST", "me/subscribed_apps", {
      token: long.access_token,
      form: { subscribed_fields: "comments" },
    });
    const media = await server.postMedia(account.id);

    const posted = await server.comment(media.id, {
      username: "fan",
      text: "Nice! 😍",
    });

    expect(posted.webhook.delivered).toBe(true);
    const [delivery] = callback.deliveries;
    const expected = createHmac("sha256", APP.secret)
      .update(delivery.raw)
      .digest("hex");
    expect(delivery.headers["x-hub-signature-256"]).toBe(`sha256=${expected}`);
    expect(delivery.body).toMatchObject({
      object: "instagram",
      entry: [
        {
          id: account.user_id,
          changes: [
            {
              field: "comments",
              value: {
                id: posted.id,
                text: "Nice! 😍",
                from: { username: "fan" },
              },
            },
          ],
        },
      ],
    });
    // Meta escapes non-ASCII in the signed bytes.
    expect(delivery.raw.toString("utf8")).toContain("\\ud83d\\ude0d");
  });

  it("sends nothing to a callback that fails the verification handshake", async () => {
    const callback = await startCallback({ verifyToken: "right" });
    const { server, graph, login } = await setup({
      webhook: { callbackUrl: callback.url, verifyToken: "wrong" },
    });
    const account = await server.createAccount({ username: "shop" });
    const { long } = await login(account.id);
    await graph("POST", "me/subscribed_apps", {
      token: long.access_token,
      form: { subscribed_fields: "comments" },
    });
    const media = await server.postMedia(account.id);

    const posted = await server.comment(media.id, {
      username: "fan",
      text: "hi",
    });

    expect(posted.webhook.skipped).toMatch(/not verified/);
    expect(callback.deliveries).toHaveLength(0);
  });

  it("sends nothing for an account that has not subscribed to comments", async () => {
    const callback = await startCallback();
    const { server } = await setup({
      webhook: { callbackUrl: callback.url, verifyToken: callback.verifyToken },
    });
    const account = await server.createAccount({ username: "shop" });
    const media = await server.postMedia(account.id);

    const posted = await server.comment(media.id, {
      username: "fan",
      text: "hi",
    });

    expect(posted.webhook.skipped).toMatch(/not subscribed/);
  });
});

describe("publishing", () => {
  it("publishes a container once it has finished, and counts it against the quota", async () => {
    const { server, graph, login } = await setup();
    const account = await server.createAccount({ username: "shop" });
    const token = (await login(account.id)).long.access_token;

    const container = await graph("POST", `${account.id}/media`, {
      token,
      form: { image_url: "https://example.com/photo.jpg", caption: "Launch" },
    });
    const status = await graph("GET", container.body.id, {
      token,
      query: { fields: "status_code" },
    });
    expect(status.body.status_code).toBe("FINISHED");

    const published = await graph("POST", `${account.id}/media_publish`, {
      token,
      form: { creation_id: container.body.id },
    });
    expect(published.body.id).toBeTruthy();
    const limit = await graph("GET", `${account.id}/content_publishing_limit`, {
      token,
    });
    expect(limit.body.data[0].quota_usage).toBe(1);
    const again = await graph("POST", `${account.id}/media_publish`, {
      token,
      form: { creation_id: container.body.id },
    });
    expect(again.status).toBe(400);
  });

  it("refuses to publish a container forced into ERROR, and past the quota", async () => {
    const { server, graph, login } = await setup();
    const account = await server.createAccount({ username: "shop" });
    const token = (await login(account.id)).long.access_token;
    const create = async () =>
      (
        await graph("POST", `${account.id}/media`, {
          token,
          form: { image_url: "https://example.com/photo.jpg" },
        })
      ).body.id;

    const broken = await create();
    await server.setContainerStatus(broken, "ERROR");
    expect(
      (
        await graph("POST", `${account.id}/media_publish`, {
          token,
          form: { creation_id: broken },
        })
      ).status,
    ).toBe(400);

    await server.setQuotaUsage(account.id, 100);
    const fine = await create();
    const refused = await graph("POST", `${account.id}/media_publish`, {
      token,
      form: { creation_id: fine },
    });
    expect(refused.body.error).toMatchObject({ code: 9 });
  });

  it("does not fetch media URLs unless downloadMedia is enabled", async () => {
    let fetched = 0;
    const media = http.createServer((request, response) => {
      fetched += 1;
      response
        .writeHead(200, { "content-type": "image/jpeg" })
        .end(Buffer.from("jpg"));
    });
    await new Promise((resolve) => media.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise((resolve) => media.close(resolve)));
    const imageUrl = `http://127.0.0.1:${media.address().port}/photo.jpg`;

    for (const downloadMedia of [false, true]) {
      const { server, graph, login } = await setup({ downloadMedia });
      const account = await server.createAccount({ username: "shop" });
      const token = (await login(account.id)).long.access_token;
      const container = await graph("POST", `${account.id}/media`, {
        token,
        form: { image_url: imageUrl },
      });
      await graph("POST", `${account.id}/media_publish`, {
        token,
        form: { creation_id: container.body.id },
      });
    }

    expect(fetched).toBe(1);
  });
});

describe("messages and faults", () => {
  it("records a private reply to a comment", async () => {
    const { server, graph, login } = await setup();
    const account = await server.createAccount({ username: "shop" });
    const token = (await login(account.id)).long.access_token;
    const media = await server.postMedia(account.id);
    const comment = await server.comment(media.id, {
      username: "fan",
      text: "price?",
    });

    const sent = await graph("POST", "me/messages", {
      token,
      form: {
        recipient: JSON.stringify({ comment_id: comment.id }),
        message: JSON.stringify({ text: "Check your DMs" }),
      },
    });

    // recipient_id is the commenter, not the comment.
    expect(sent.body).toMatchObject({
      recipient_id: comment.from.id,
      message_id: expect.any(String),
    });
    const [recorded] = await server.getMessages();
    expect(recorded).toMatchObject({
      recipient: { comment_id: comment.id },
      text: "Check your DMs",
    });
  });

  it("injects a Graph error for the next matching call only", async () => {
    const { server, graph, login } = await setup();
    const account = await server.createAccount({ username: "shop" });
    const token = (await login(account.id)).long.access_token;
    await server.addFault({
      method: "GET",
      path: "/me$",
      status: 500,
      code: 2,
    });

    expect((await graph("GET", "me", { token })).status).toBe(500);
    expect((await graph("GET", "me", { token })).status).toBe(200);
  });
});

describe("messaging rules", () => {
  async function account() {
    const context = await setup();
    const shop = await context.server.createAccount({ username: "shop" });
    const token = (await context.login(shop.id)).long.access_token;
    const send = (recipient, text = "hi") =>
      context.graph("POST", "me/messages", {
        token,
        form: {
          recipient: JSON.stringify(recipient),
          message: JSON.stringify({ text }),
        },
      });
    return { ...context, shop, token, send };
  }

  it("allows one private reply per comment, and none after 7 days", async () => {
    const { server, shop, send } = await account();
    const media = await server.postMedia(shop.id);
    const first = await server.comment(media.id, {
      username: "fan",
      text: "price?",
    });
    const old = await server.comment(media.id, {
      username: "fan2",
      text: "price?",
    });
    await server.ageComment(old.id, 24 * 8);

    expect((await send({ comment_id: first.id })).status).toBe(200);
    const again = await send({ comment_id: first.id });
    expect(again.body.error).toMatchObject({
      code: 10,
      error_subcode: 2534022,
    });
    expect((await send({ comment_id: old.id })).body.error).toMatchObject({
      code: 10,
    });
  });

  it("refuses a private reply to a comment on another account's media", async () => {
    const { server, send } = await account();
    const other = await server.createAccount({ username: "rival" });
    const media = await server.postMedia(other.id);
    const theirs = await server.comment(media.id, {
      username: "fan",
      text: "hi",
    });

    expect((await send({ comment_id: theirs.id })).body.error).toMatchObject({
      code: 100,
      error_subcode: 33,
    });
  });

  it("lets the app message a person only within 24 hours of the person's last message", async () => {
    const { server, shop, send } = await account();
    const person = await server.createPerson({ username: "customer" });

    expect((await send({ id: person.id })).body.error).toMatchObject({
      code: 10,
      error_subcode: 2534022,
    });
    await server.sendMessageToAccount(shop.id, {
      person_id: person.id,
      text: "hello?",
    });
    expect((await send({ id: person.id })).status).toBe(200);

    await server.sendMessageToAccount(shop.id, {
      person_id: person.id,
      text: "old",
      hours_ago: 30,
    });
    expect((await send({ id: person.id })).body.error).toMatchObject({
      code: 10,
    });
    expect((await send({ id: "123" })).body.error).toMatchObject({
      code: 100,
      error_subcode: 2534014,
    });
  });

  it("delivers a person's message as Meta's messages webhook, in milliseconds", async () => {
    const callback = await startCallback();
    const { server, graph, login } = await setup({
      webhook: { callbackUrl: callback.url, verifyToken: callback.verifyToken },
    });
    const shop = await server.createAccount({ username: "shop" });
    const token = (await login(shop.id)).long.access_token;
    await graph("POST", "me/subscribed_apps", {
      token,
      form: { subscribed_fields: "messages" },
    });

    const sent = await server.sendMessageToAccount(shop.id, {
      username: "customer",
      text: "hi",
    });

    expect(sent.webhook.delivered).toBe(true);
    const [entry] = callback.deliveries[0].body.entry;
    expect(entry).toMatchObject({
      id: shop.user_id,
      messaging: [
        {
          sender: { id: sent.person_id },
          recipient: { id: shop.user_id },
          message: { mid: sent.mid, text: "hi" },
        },
      ],
    });
    expect(entry.time).toBeGreaterThan(1e12);
  });

  it("returns a person's profile only after they messaged the account", async () => {
    const { server, shop, graph, token } = await account();
    const person = await server.createPerson({
      username: "customer",
      name: "Cus Tomer",
    });

    expect((await graph("GET", person.id, { token })).body.error.message).toBe(
      "User consent is required to access user profile.",
    );
    await server.sendMessageToAccount(shop.id, {
      person_id: person.id,
      text: "hi",
    });
    expect(
      (
        await graph("GET", person.id, {
          token,
          query: { fields: "name,username" },
        })
      ).body,
    ).toEqual({ id: person.id, name: "Cus Tomer", username: "customer" });
  });
});

describe("Graph details", () => {
  it("gives the account an app-scoped id and its professional account id as user_id", async () => {
    const { server, graph, login } = await setup();
    const shop = await server.createAccount({ username: "shop" });
    const token = (await login(shop.id)).long.access_token;

    const [me] = (
      await graph("GET", "me", {
        token,
        query: { fields: "id,user_id,username" },
      })
    ).body.data;
    expect(me.id).not.toBe(me.user_id);
    // Both ids address the account.
    expect(
      (await graph("GET", me.user_id, { token, query: { fields: "username" } }))
        .body.username,
    ).toBe("shop");
    expect(
      (await graph("GET", me.id, { token, query: { fields: "username" } })).body
        .username,
    ).toBe("shop");
  });

  it("expands nested fields and replies", async () => {
    const { server, graph, login } = await setup();
    const shop = await server.createAccount({ username: "shop" });
    const token = (await login(shop.id)).long.access_token;
    const media = await server.postMedia(shop.id, {
      media_product_type: "REELS",
    });
    const comment = await server.comment(media.id, {
      username: "fan",
      text: "top",
    });
    await server.comment(media.id, {
      username: "fan2",
      text: "reply",
      parent_id: comment.id,
    });

    const listed = await graph("GET", `${media.id}/comments`, {
      token,
      query: {
        fields:
          "id,text,from{username},media{media_product_type},replies{text}",
      },
    });

    expect(listed.body.data[0]).toEqual({
      id: comment.id,
      text: "top",
      from: { username: "fan" },
      media: { media_product_type: "REELS" },
      replies: { data: [{ id: expect.any(String), text: "reply" }] },
    });
  });

  it("accepts unversioned Graph paths and space-separated scopes", async () => {
    const { server, graph, login } = await setup();
    const shop = await server.createAccount({ username: "shop" });
    const token = (
      await login(shop.id, [
        "instagram_business_basic instagram_business_manage_comments",
      ])
    ).long.access_token;

    const response = await fetch(
      new URL("/me?fields=username", server.origin),
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    expect(response.status).toBe(200);
    const media = await server.postMedia(shop.id);
    expect((await graph("GET", `${media.id}/comments`, { token })).status).toBe(
      200,
    );
  });

  it("keeps paging after the last comment of a page is deleted", async () => {
    const { server, graph, login } = await setup();
    const shop = await server.createAccount({ username: "shop" });
    const token = (await login(shop.id)).long.access_token;
    const media = await server.postMedia(shop.id);
    for (const text of ["a", "b", "c", "d"])
      await server.comment(media.id, { username: "fan", text });

    const first = await graph("GET", `${media.id}/comments`, {
      token,
      query: { limit: "2" },
    });
    await graph("DELETE", first.body.data[1].id, { token });
    const second = await graph("GET", `${media.id}/comments`, {
      token,
      query: { limit: "2", after: first.body.paging.cursors.after },
    });

    expect(second.status).toBe(200);
    expect(second.body.data.map((item) => item.text)).toEqual(["b", "a"]);
  });

  it("refuses a comment with no text, and a reply to a hidden comment", async () => {
    const { server, graph, login } = await setup();
    const shop = await server.createAccount({ username: "shop" });
    const token = (await login(shop.id)).long.access_token;
    const media = await server.postMedia(shop.id);
    const comment = await server.comment(media.id, {
      username: "fan",
      text: "spam",
    });

    expect(
      (await graph("POST", `${media.id}/comments`, { token, form: {} })).status,
    ).toBe(400);
    await graph("POST", comment.id, { token, query: { hide: "true" } });
    expect(
      (
        await graph("POST", `${comment.id}/replies`, {
          token,
          form: { message: "hi" },
        })
      ).status,
    ).toBe(400);
  });

  it("answers expired and unknown containers with Meta's error", async () => {
    const { server, graph, login } = await setup();
    const shop = await server.createAccount({ username: "shop" });
    const token = (await login(shop.id)).long.access_token;
    const container = await graph("POST", `${shop.id}/media`, {
      token,
      form: { image_url: "https://example.com/p.jpg" },
    });
    await server.setContainerStatus(container.body.id, "EXPIRED");

    for (const creation_id of [container.body.id, "999"]) {
      expect(
        (
          await graph("POST", `${shop.id}/media_publish`, {
            token,
            form: { creation_id },
          })
        ).body.error,
      ).toMatchObject({ code: 24, error_subcode: 2207008 });
    }
  });
});

describe("robustness", () => {
  it("answers 400, not a crash, to malformed paths and bodies", async () => {
    const { server } = await setup();
    for (const path of ["//v25.0/me", "/v25.0/%E0", "/_fake/files/%E0"]) {
      const response = await fetch(server.origin + path);
      expect(response.status).toBeLessThan(500);
    }
    const text = await fetch(new URL("/v25.0/me/comments", server.origin), {
      method: "POST",
      body: "plain",
      headers: { "content-type": "text/plain", authorization: "Bearer x" },
    });
    expect(text.status).toBe(400);
    // The server is still up.
    expect((await fetch(server.origin + "/_fake/health")).status).toBe(200);
  });

  it("does not repeat ids across servers in the same run", async () => {
    const ids = new Set();
    for (let run = 0; run < 3; run += 1) {
      const { server } = await setup();
      const shop = await server.createAccount({ username: "shop" });
      for (let index = 0; index < 20; index += 1)
        ids.add((await server.postMedia(shop.id)).id);
    }
    expect(ids.size).toBe(60);
  });

  it("stops without delivering pending webhook retries afterwards", async () => {
    const callback = await startCallback({ status: 500 });
    const { server, graph, login } = await setup({
      webhook: { callbackUrl: callback.url, verifyToken: callback.verifyToken },
    });
    const shop = await server.createAccount({ username: "shop" });
    const token = (await login(shop.id)).long.access_token;
    await graph("POST", "me/subscribed_apps", {
      token,
      form: { subscribed_fields: "comments" },
    });
    const media = await server.postMedia(shop.id);
    const commenting = server.comment(media.id, {
      username: "fan",
      text: "hi",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    await server.stop();
    await commenting.catch(() => {});
    const after = callback.deliveries.length;
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(callback.deliveries.length).toBe(after);
  });

  it("returns snapshots, not live state, from the helpers", async () => {
    const { server, graph, login } = await setup();
    const shop = await server.createAccount({ username: "shop" });
    const token = (await login(shop.id)).long.access_token;
    const media = await server.postMedia(shop.id);
    const comment = await server.comment(media.id, {
      username: "fan",
      text: "hi",
    });

    const before = await server.getComment(comment.id);
    await graph("POST", comment.id, { token, query: { hide: "true" } });

    expect(before.hidden).toBe(false);
    expect(before.history).toHaveLength(1);
  });
});

describe("messaging events", () => {
  /** An account subscribed to the given fields, with a recording callback. */
  async function subscribed(fields) {
    const callback = await startCallback();
    const context = await setup({
      webhook: { callbackUrl: callback.url, verifyToken: callback.verifyToken },
    });
    const shop = await context.server.createAccount({ username: "shop" });
    const token = (await context.login(shop.id)).long.access_token;
    const subscribe = await context.graph("POST", "me/subscribed_apps", {
      token,
      form: { subscribed_fields: fields },
    });
    expect(subscribe.body).toEqual({ success: true });
    const events = (field) =>
      callback.deliveries
        .flatMap((delivery) => delivery.body.entry)
        .flatMap((entry) => entry.messaging ?? [])
        .filter((event) =>
          field === "reaction" ? event.reaction : event.message,
        );
    return { ...context, callback, shop, token, events };
  }

  it("echoes the account's own sends to accounts subscribed to message_echoes", async () => {
    const { server, graph, token, shop, events } = await subscribed(
      "messages,message_echoes",
    );
    const incoming = await server.sendMessageToAccount(shop.id, {
      username: "customer",
      text: "look",
      attachments: [{ type: "image", url: "https://example.com/a.jpg" }],
    });
    const reply = await server.sendMessageToAccount(shop.id, {
      person_id: incoming.person_id,
      text: "this one",
      reply_to: incoming.mid,
    });
    expect(reply.webhook.delivered).toBe(true);

    const sent = await graph("POST", "me/messages", {
      token,
      form: {
        recipient: JSON.stringify({ id: incoming.person_id }),
        message: JSON.stringify({ text: "Thanks!" }),
      },
    });
    await expect
      .poll(() => events("message").some((event) => event.message.is_echo))
      .toBe(true);

    const [image, answer, echo] = events("message");
    expect(image.message).toEqual({
      mid: incoming.mid,
      text: "look",
      attachments: [
        { type: "image", payload: { url: "https://example.com/a.jpg" } },
      ],
    });
    expect(answer.message).toMatchObject({ reply_to: { mid: incoming.mid } });
    expect(echo).toMatchObject({
      sender: { id: shop.user_id },
      recipient: { id: incoming.person_id },
      message: { mid: sent.body.message_id, text: "Thanks!", is_echo: true },
    });
  });

  it("sends no echo to an account subscribed to messages only", async () => {
    const { server, graph, token, shop, events } = await subscribed("messages");
    const incoming = await server.sendMessageToAccount(shop.id, {
      username: "customer",
      text: "hi",
    });
    await graph("POST", "me/messages", {
      token,
      form: {
        recipient: JSON.stringify({ id: incoming.person_id }),
        message: JSON.stringify({ text: "hello" }),
      },
    });
    await expect
      .poll(async () =>
        (await server.getWebhook()).deliveries.some(
          (delivery) => delivery.field === "message_echoes",
        ),
      )
      .toBe(true);
    const echo = (await server.getWebhook()).deliveries.find(
      (delivery) => delivery.field === "message_echoes",
    );
    expect(echo.skipped).toBe("account is not subscribed to message_echoes");
    expect(events("message").map((event) => event.message.text)).toEqual([
      "hi",
    ]);
  });

  it("tells the app when a person unsends a message, and when they react to one", async () => {
    const { server, graph, token, shop, events } = await subscribed(
      "messages,message_reactions",
    );
    const incoming = await server.sendMessageToAccount(shop.id, {
      username: "customer",
      text: "oops",
    });
    const sent = await graph("POST", "me/messages", {
      token,
      form: {
        recipient: JSON.stringify({ id: incoming.person_id }),
        message: JSON.stringify({ text: "Here is the link" }),
      },
    });

    await server.deleteMessage(shop.id, incoming.mid);
    await server.reactToMessage(shop.id, sent.body.message_id, {
      reaction: "love",
      emoji: "❤️",
    });
    await server.reactToMessage(shop.id, sent.body.message_id, {
      action: "unreact",
    });

    expect(events("message").at(-1)).toMatchObject({
      sender: { id: incoming.person_id },
      message: { mid: incoming.mid, is_deleted: true },
    });
    expect(events("reaction").map((event) => event.reaction)).toEqual([
      {
        mid: sent.body.message_id,
        action: "react",
        reaction: "love",
        emoji: "❤️",
      },
      { mid: sent.body.message_id, action: "unreact" },
    ]);
    expect(events("reaction")[0].sender).toEqual({ id: incoming.person_id });
  });

  it("refuses a webhook field Meta does not have", async () => {
    const { server, graph, login } = await setup();
    const shop = await server.createAccount({ username: "shop" });
    const token = (await login(shop.id)).long.access_token;
    const answer = await graph("POST", "me/subscribed_apps", {
      token,
      form: { subscribed_fields: "messages,messaging_reactions" },
    });
    expect(answer.status).toBe(400);
    expect(answer.body.error).toMatchObject({ code: 100 });
    expect(answer.body.error.message).toMatch(/messaging_reactions/);
  });
});

describe("rate limits", () => {
  it("reports an account's usage and refuses calls over its limit with code 80002", async () => {
    const { server, graph, login } = await setup();
    const shop = await server.createAccount({ username: "shop" });
    const token = (await login(shop.id)).long.access_token;
    await server.setCallLimit(shop.id, 4);

    const usage = async () => {
      const answer = await graph("GET", "me", { token });
      return {
        status: answer.status,
        code: answer.body.error?.code,
        usage: JSON.parse(answer.headers.get("x-business-use-case-usage"))[
          shop.user_id
        ][0],
      };
    };
    expect(await usage()).toMatchObject({
      status: 200,
      usage: { type: "instagram", call_count: 25 },
    });
    await usage();
    await usage();
    expect((await usage()).usage.call_count).toBe(100);
    const refused = await usage();
    expect(refused).toMatchObject({ status: 400, code: 80002 });
    expect(refused.usage.estimated_time_to_regain_access).toBeGreaterThan(0);

    await server.setCallLimit(shop.id, null);
    expect(await usage()).toMatchObject({
      status: 200,
      usage: { call_count: 0, estimated_time_to_regain_access: 0 },
    });
  });

  it("limits private replies to 750 an hour", async () => {
    const { server, graph, login } = await setup();
    const shop = await server.createAccount({ username: "shop" });
    const token = (await login(shop.id)).long.access_token;
    const post = await server.postMedia(shop.id);
    const reply = async () => {
      const comment = await server.comment(post.id, {
        username: "fan",
        text: "info?",
      });
      return graph("POST", "me/messages", {
        token,
        form: {
          recipient: JSON.stringify({ comment_id: comment.id }),
          message: JSON.stringify({ text: "Sent you a DM" }),
        },
      });
    };
    for (let count = 0; count < 750; count += 1) {
      expect((await reply()).status).toBe(200);
    }
    const refused = await reply();
    expect(refused.body.error).toMatchObject({
      code: 613,
      error_subcode: 2534040,
    });
  }, 60_000);

  it("limits Send API messages to 100 a second", async () => {
    const { server, graph, login } = await setup();
    const shop = await server.createAccount({ username: "shop" });
    const token = (await login(shop.id)).long.access_token;
    const { person_id: personId } = await server.sendMessageToAccount(shop.id, {
      username: "customer",
      text: "hi",
    });
    const answers = await Promise.all(
      Array.from({ length: 110 }, () =>
        graph("POST", "me/messages", {
          token,
          form: {
            recipient: JSON.stringify({ id: personId }),
            message: JSON.stringify({ text: "hello" }),
          },
        }),
      ),
    );
    const refused = answers.filter((answer) => answer.status !== 200);
    expect(refused.length).toBeGreaterThanOrEqual(10);
    expect(refused[0].body.error).toMatchObject({
      code: 613,
      error_subcode: 2534040,
    });
  });

  it("answers an injected error with its subcode", async () => {
    const { server, graph, login } = await setup();
    const shop = await server.createAccount({ username: "shop" });
    const token = (await login(shop.id)).long.access_token;
    await server.addFault({
      path: "/me$",
      status: 400,
      code: 4,
      subcode: 2207051,
      message: "We restrict certain activity to protect our community.",
    });
    expect((await graph("GET", "me", { token })).body.error).toMatchObject({
      code: 4,
      error_subcode: 2207051,
    });
  });
});

describe("carousels", () => {
  async function publisher() {
    const context = await setup();
    const shop = await context.server.createAccount({ username: "shop" });
    const token = (await context.login(shop.id)).long.access_token;
    const create = (form) =>
      context.graph("POST", `${shop.id}/media`, { token, form });
    const item = async (form) =>
      (await create({ is_carousel_item: "true", ...form })).body.id;
    return { ...context, shop, token, create, item };
  }

  it("publishes 2 to 10 items as one album, counted once, with its items as children", async () => {
    const { graph, shop, token, create, item } = await publisher();
    const photo = await item({ image_url: "https://example.com/a.jpg" });
    const video = await item({
      media_type: "VIDEO",
      video_url: "https://example.com/b.mp4",
    });
    const album = await create({
      media_type: "CAROUSEL",
      children: `${photo},${video}`,
      caption: "Two views",
    });
    await expect
      .poll(
        async () =>
          (
            await graph("GET", album.body.id, {
              token,
              query: { fields: "status_code" },
            })
          ).body.status_code,
      )
      .toBe("FINISHED");

    const alone = await graph("POST", `${shop.id}/media_publish`, {
      token,
      form: { creation_id: photo },
    });
    expect(alone.status).toBe(400);
    const published = await graph("POST", `${shop.id}/media_publish`, {
      token,
      form: { creation_id: album.body.id },
    });

    const post = await graph("GET", published.body.id, {
      token,
      query: { fields: "media_type,caption,children{media_type}" },
    });
    expect(post.body).toMatchObject({
      media_type: "CAROUSEL_ALBUM",
      caption: "Two views",
      children: { data: [{ media_type: "IMAGE" }, { media_type: "VIDEO" }] },
    });
    const listed = await graph("GET", `${shop.id}/media`, { token });
    expect(listed.body.data.map((entry) => entry.id)).toEqual([
      published.body.id,
    ]);
    const limit = await graph("GET", `${shop.id}/content_publishing_limit`, {
      token,
    });
    expect(limit.body.data[0].quota_usage).toBe(1);
  });

  it("refuses a carousel with fewer than 2 items, or with a container that is not an item", async () => {
    const { create, item } = await publisher();
    const photo = await item({ image_url: "https://example.com/a.jpg" });
    const single = (await create({ image_url: "https://example.com/c.jpg" }))
      .body.id;

    const tooFew = await create({ media_type: "CAROUSEL", children: photo });
    expect(tooFew.body.error).toMatchObject({
      code: 100,
      error_subcode: 2207028,
    });
    const notItem = await create({
      media_type: "CAROUSEL",
      children: `${photo},${single}`,
    });
    expect(notItem.status).toBe(400);
  });
});

describe("mentions", () => {
  async function twoAccounts() {
    const callback = await startCallback();
    const context = await setup({
      webhook: { callbackUrl: callback.url, verifyToken: callback.verifyToken },
    });
    const brand = await context.server.createAccount({ username: "brand" });
    const creator = await context.server.createAccount({ username: "creator" });
    const token = (await context.login(brand.id)).long.access_token;
    await context.graph("POST", "me/subscribed_apps", {
      token,
      form: { subscribed_fields: "mentions" },
    });
    const mentions = () =>
      callback.deliveries
        .flatMap((delivery) => delivery.body.entry)
        .filter((entry) => entry.changes?.[0]?.field === "mentions");
    return { ...context, brand, creator, token, mentions };
  }

  it("tells an account it was tagged in a comment elsewhere, and lets it read that comment", async () => {
    const { server, graph, brand, creator, token, mentions } =
      await twoAccounts();
    const post = await server.postMedia(creator.id, { caption: "Outfit" });
    const comment = await server.comment(post.id, {
      username: "fan",
      text: "Where is this from @Brand?",
    });

    await expect.poll(() => mentions().length).toBe(1);
    expect(mentions()[0]).toMatchObject({
      id: brand.user_id,
      changes: [
        {
          field: "mentions",
          value: { comment_id: comment.id, media_id: post.id },
        },
      ],
    });
    const read = await graph("GET", brand.user_id, {
      token,
      query: {
        fields: `mentioned_comment.comment_id(${comment.id}){text,username}`,
      },
    });
    expect(read.body.mentioned_comment).toMatchObject({
      text: "Where is this from @Brand?",
      username: "fan",
    });
    const direct = await graph("GET", comment.id, { token });
    expect(direct.status).toBe(400);
  });

  it("tells an account it was tagged in a caption, but not about its own media", async () => {
    const { server, graph, brand, creator, token, mentions } =
      await twoAccounts();
    const tagged = await server.postMedia(creator.id, {
      caption: "Wearing @brand today",
    });
    await server.postMedia(brand.id, { caption: "New from @brand" });

    await expect.poll(() => mentions().length).toBe(1);
    expect(mentions()[0].changes[0].value).toEqual({ media_id: tagged.id });
    const read = await graph("GET", brand.user_id, {
      token,
      query: { fields: `mentioned_media.media_id(${tagged.id}){caption}` },
    });
    expect(read.body.mentioned_media).toMatchObject({
      caption: "Wearing @brand today",
    });
  });

  it("refuses to read a comment that does not tag the account", async () => {
    const { server, graph, brand, creator, token } = await twoAccounts();
    const post = await server.postMedia(creator.id);
    const comment = await server.comment(post.id, {
      username: "fan",
      text: "no tag here",
    });
    const read = await graph("GET", brand.user_id, {
      token,
      query: { fields: `mentioned_comment.comment_id(${comment.id}){text}` },
    });
    expect(read.status).toBe(400);
  });
});

describe("what a DM assistant needs", () => {
  async function messaging() {
    const callback = await startCallback();
    const context = await setup({
      webhook: { callbackUrl: callback.url, verifyToken: callback.verifyToken },
    });
    const shop = await context.server.createAccount({ username: "shop" });
    const token = (await context.login(shop.id)).long.access_token;
    await context.graph("POST", "me/subscribed_apps", {
      token,
      form: { subscribed_fields: "messages,message_echoes" },
    });
    const send = (personId, text = "hi") =>
      context.graph("POST", "me/messages", {
        token,
        form: {
          recipient: JSON.stringify({ id: personId }),
          message: JSON.stringify({ text }),
        },
      });
    const events = () =>
      callback.deliveries
        .flatMap((delivery) => delivery.body.entry)
        .flatMap((entry) => entry.messaging ?? []);
    return { ...context, callback, shop, token, send, events };
  }

  it("reports who follows whom, only once the person has messaged the account", async () => {
    const { server, graph, shop, token } = await messaging();
    const person = await server.createPerson({
      username: "fan",
      is_user_follow_business: true,
    });
    const profile = () =>
      graph("GET", person.id, {
        token,
        query: { fields: "is_user_follow_business,is_business_follow_user" },
      });

    expect((await profile()).status).toBe(400);
    await server.sendMessageToAccount(shop.id, {
      person_id: person.id,
      text: "hi",
    });
    expect((await profile()).body).toMatchObject({
      is_user_follow_business: true,
      is_business_follow_user: false,
    });
    await server.updatePerson(person.id, { is_business_follow_user: true });
    expect((await profile()).body.is_business_follow_user).toBe(true);
  });

  it("sends only an echo when the owner writes from the app, and opens no reply window", async () => {
    const { server, shop, send, events } = await messaging();
    const person = await server.createPerson({ username: "customer" });

    const written = await server.sendAsOwner(shop.id, {
      person_id: person.id,
      text: "I'll take it from here",
    });

    expect(written.webhook).toMatchObject({
      field: "message_echoes",
      delivered: true,
    });
    expect(events()).toEqual([
      expect.objectContaining({
        sender: { id: shop.user_id },
        recipient: { id: person.id },
        message: {
          mid: written.mid,
          text: "I'll take it from here",
          is_echo: true,
        },
      }),
    ]);
    expect(await server.getMessages()).toEqual([]);
    expect((await send(person.id)).body.error).toMatchObject({
      code: 10,
      error_subcode: 2534022,
    });
  });

  it("redelivers a message and an echo with the same body and signature", async () => {
    const { server, shop, send, callback } = await messaging();
    const incoming = await server.sendMessageToAccount(shop.id, {
      username: "customer",
      text: "hello",
    });
    const sent = await send(incoming.person_id, "Hi!");
    await expect.poll(() => callback.deliveries.length).toBe(2);
    const [inboundDelivery, echoDelivery] = callback.deliveries;

    await server.redeliverMessage(incoming.mid);
    await server.redeliverMessage(sent.body.message_id);

    expect(callback.deliveries).toHaveLength(4);
    for (const [original, again] of [
      [inboundDelivery, callback.deliveries[2]],
      [echoDelivery, callback.deliveries[3]],
    ]) {
      expect(again.raw.equals(original.raw)).toBe(true);
      expect(again.headers["x-hub-signature-256"]).toBe(
        original.headers["x-hub-signature-256"],
      );
    }
    const unknown = await fetch(
      new URL("/_fake/messages/unknown-mid/redeliver", server.origin),
      { method: "POST" },
    );
    expect(unknown.status).toBe(404);
  });

  it("keeps failing sends after a revoke, and on an injected code 4", async () => {
    const { server, shop, send } = await messaging();
    const incoming = await server.sendMessageToAccount(shop.id, {
      username: "customer",
      text: "hi",
    });
    await server.addFault({
      method: "POST",
      path: "/messages$",
      status: 400,
      code: 4,
      message: "Application request limit reached",
    });
    expect((await send(incoming.person_id)).body.error).toMatchObject({
      code: 4,
    });
    await server.changeTokens(shop.id, { revoke: true });
    expect((await send(incoming.person_id)).body.error).toMatchObject({
      code: 190,
    });
  });
});
