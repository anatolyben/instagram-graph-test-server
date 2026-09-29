/**
 * A local, in-memory fake of the Instagram Graph API (Instagram API with
 * Instagram Login), for tests.
 *
 * App side: point the app's Instagram hosts (www.instagram.com for the login
 * page, api.instagram.com for the code exchange, graph.instagram.com for the
 * Graph API) at this server. It answers like Meta and keeps the platform's
 * state: professional accounts with their tokens and scopes, media, comments
 * and replies (hidden, deleted, edited), webhook subscriptions, publishing
 * containers and the publishing quota. It sends signed `comments` webhooks to
 * the registered callback after the callback passes Meta's verification
 * handshake.
 *
 * Instagram side: tests drive it through /_fake/* or the helpers returned by
 * startTestServer (create an account, post media, comment or reply as a
 * person, edit or delete that comment, choose the next login answer, age or
 * revoke tokens, force a container state, inject a Graph fault) and read back
 * what the app did.
 *
 * Nothing here talks to Meta.
 */
import http from "node:http";
import { createHmac, randomBytes } from "node:crypto";

const SCOPES = Object.freeze({
  basic: "instagram_business_basic",
  comments: "instagram_business_manage_comments",
  publish: "instagram_business_content_publish",
  messages: "instagram_business_manage_messages",
});
const SHORT_TOKEN_MS = 60 * 60 * 1000;
const LONG_TOKEN_SECONDS = 5_183_944;
const REFRESH_MIN_AGE_MS = 24 * 60 * 60 * 1000;
const CONTAINER_LIFETIME_MS = 24 * 60 * 60 * 1000;
const PUBLISH_QUOTA = { quota_total: 100, quota_duration: 86_400 };
const CONTAINER_STATUS = Object.freeze({
  IN_PROGRESS: "In Progress: Media is still being processed.",
  FINISHED:
    "Finished: Media has been uploaded and it is ready to be published.",
  PUBLISHED: "Published: Media has been published.",
  EXPIRED: "Expired: The container was not published within 24 hours.",
  ERROR: "Error: Media upload has failed.",
});
const MAX_MEDIA_BYTES = 300 * 1024 * 1024;
const MESSAGING_WINDOW_MS = 24 * 60 * 60 * 1000;
const PRIVATE_REPLY_MS = 7 * 24 * 60 * 60 * 1000;
// Meta's messaging limits per account: private replies to post and reel
// comments per hour, and Send API calls per second.
const PRIVATE_REPLIES_PER_HOUR = 750;
const SENDS_PER_SECOND = 100;
// The Business Use Case window a call limit counts over.
const CALL_WINDOW_MS = 24 * 60 * 60 * 1000;
// The webhook fields an account can subscribe to, as Meta lists them.
const WEBHOOK_FIELDS = new Set([
  "comments",
  "live_comments",
  "mentions",
  "messages",
  "message_reactions",
  "message_echoes",
  "messaging_postbacks",
  "messaging_seen",
  "messaging_referral",
  "messaging_optins",
  "messaging_handover",
  "messaging_policy_enforcement",
  "response_feedback",
  "standby",
  "story_insights",
]);
// What a person can send the account, in Meta's attachment types.
const INCOMING_ATTACHMENTS = new Set([
  "image",
  "video",
  "audio",
  "file",
  "share",
  "story_mention",
  "ig_reel",
]);
// Meta expects a webhook receiver to answer within 5 seconds.
const WEBHOOK_TIMEOUT_MS = 5_000;

// Ids start from the clock with room for a million per millisecond, and one
// counter is shared by every server in the process, so neither a restarted
// server nor a second one in the same test run repeats an id.
const idBase = BigInt(Date.now()) * 1_000_000n;
let idSequence = 0n;
function uniqueNumber() {
  idSequence += 1n;
  return idBase + idSequence;
}

class GraphError extends Error {
  constructor(
    status,
    message,
    { type = "OAuthException", code, subcode, errorData } = {},
  ) {
    super(message);
    this.status = status;
    this.type = type;
    this.code = code;
    this.subcode = subcode;
    this.errorData = errorData;
  }
}

class ControlError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const missingObject = (id) =>
  new GraphError(
    400,
    `Unsupported get request. Object with ID '${id}' does not exist, cannot be loaded due to missing permissions, or does not support this operation. Please read the Graph API documentation at https://developers.facebook.com/docs/graph-api`,
    { type: "GraphMethodException", code: 100, subcode: 33 },
  );

const missingPermission = () =>
  new GraphError(
    403,
    "(#10) Application does not have permission for this action",
    {
      code: 10,
    },
  );

/**
 * Meta serializes webhook bodies with every non-ASCII character and "/"
 * escaped, and signs those exact bytes; a receiver that re-serializes the
 * parsed body can never match the signature.
 */
function metaJson(value) {
  return JSON.stringify(value)
    .replace(/\//g, "\\/")
    .replace(
      /[\u0080-\uffff]/g,
      (character) =>
        `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
}

function iso(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "+0000");
}

function shortcode() {
  return randomBytes(8).toString("base64url").slice(0, 11);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

async function bodyParams(request, body) {
  if (!body.length) return {};
  const type = String(request.headers["content-type"] ?? "");
  if (type.includes("application/json")) {
    try {
      const value = JSON.parse(body.toString("utf8"));
      if (value && typeof value === "object" && !Array.isArray(value))
        return value;
      throw new Error("not an object");
    } catch {
      throw new GraphError(400, "(#100) The request body is not valid JSON", {
        code: 100,
      });
    }
  }
  if (
    !type.includes("multipart/form-data") &&
    !type.includes("application/x-www-form-urlencoded")
  ) {
    throw new GraphError(
      400,
      "(#100) Send parameters as a query string, JSON, or form data",
      { code: 100 },
    );
  }
  let form;
  try {
    form = await new Request("http://localhost/", {
      method: "POST",
      headers: { "content-type": type },
      body,
    }).formData();
  } catch {
    throw new GraphError(
      400,
      "(#100) The request body is not valid form data",
      {
        code: 100,
      },
    );
  }
  const params = {};
  for (const [key, value] of form.entries()) {
    params[key] = typeof value === "string" ? value : "<file>";
  }
  return params;
}

/**
 * Parse a Graph `fields` list with field expansion, e.g.
 * `id,text,from{id,username},replies{id,text}` becomes
 * [{name:"id"}, {name:"text"}, {name:"from", sub:[...]}, {name:"replies", sub:[...]}].
 */
function parseFields(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  let index = 0;
  function list() {
    const out = [];
    let name = "";
    const push = (sub) => {
      const trimmed = name.trim();
      if (trimmed) out.push(sub ? { name: trimmed, sub } : { name: trimmed });
      name = "";
    };
    while (index < value.length) {
      const character = value[index++];
      if (character === ",") push();
      else if (character === "{") {
        const sub = list();
        push(sub);
        if (value[index] === ",") index += 1;
      } else if (character === "}") {
        push();
        return out;
      } else name += character;
    }
    push();
    return out;
  }
  return list();
}

const asFields = (names) => names.map((name) => ({ name }));

/**
 * Graph returns the id plus the requested fields that exist on the node. An
 * expanded object field returns only its requested sub-fields; an expanded
 * edge (a function in the view) is resolved with its sub-fields.
 */
function select(view, fields) {
  const out = { id: view.id };
  for (const { name, sub } of fields ?? []) {
    if (!(name in view) || view[name] === undefined) continue;
    const value = view[name];
    if (typeof value === "function") out[name] = value(sub ?? null);
    else if (
      sub &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      const nested = {};
      for (const { name: key } of sub) {
        if (value[key] !== undefined) nested[key] = value[key];
      }
      out[name] = nested;
    } else out[name] = value;
  }
  return out;
}

function encodeCursor(id) {
  return Buffer.from(String(id)).toString("base64url");
}

function decodeCursor(cursor) {
  try {
    return Buffer.from(String(cursor), "base64url").toString("utf8");
  } catch {
    return null;
  }
}

/**
 * @param {{
 *   port?: number,
 *   host?: string,
 *   app: { id: string, secret: string, redirectUris: string[] },
 *   webhook?: { callbackUrl: string, verifyToken: string } | null,
 *   downloadMedia?: boolean,
 *   mediaOrigins?: Record<string, string>,
 *   videoPollsUntilFinished?: number,
 *   log?: (line: string) => void,
 * }} options
 */
export async function startTestServer({
  port = 0,
  host = "127.0.0.1",
  app,
  webhook: webhookConfig = null,
  downloadMedia = false,
  mediaOrigins = {},
  videoPollsUntilFinished = 1,
  log = () => {},
}) {
  if (webhookConfig) {
    let callback;
    try {
      callback = new URL(webhookConfig.callbackUrl);
    } catch {
      callback = null;
    }
    if (!callback || !["http:", "https:"].includes(callback.protocol)) {
      throw new TypeError(
        "webhook.callbackUrl must be an absolute http(s) URL",
      );
    }
  }
  if (!app?.id || !app?.secret || !Array.isArray(app.redirectUris)) {
    throw new TypeError(
      "startTestServer needs app: { id, secret, redirectUris }",
    );
  }
  let origin = null;
  const accounts = new Map();
  const accountsByScopedId = new Map();
  const people = new Map();
  const media = new Map();
  const comments = new Map();
  const containers = new Map();
  const tokens = new Map();
  const codes = new Map();
  const messages = [];
  // A person's messages to an account, keyed "<accountId>:<personId>". Meta lets
  // the app reply within 24 hours of the last one, and only then read the
  // person's profile.
  const lastIncoming = new Map();
  const incoming = [];
  // The exact webhook body of each message and echo delivered, by mid.
  const sentMessaging = new Map();
  // The body of each webhook delivery, by delivery id.
  const deliveryBodies = new Map();
  const calls = [];
  const deliveries = [];
  const unimplemented = new Set();
  let faults = [];
  let nextLogin = null;
  let webhook = webhookConfig
    ? { ...webhookConfig, verified: false, verifyError: null }
    : null;
  let delivery = Promise.resolve();
  // Outgoing requests (webhooks, verification, downloads), aborted on stop().
  let stopped = false;
  const shutdown = new AbortController();
  const outgoing = (timeoutMs) =>
    AbortSignal.any([shutdown.signal, AbortSignal.timeout(timeoutMs)]);
  const pause = (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      shutdown.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  // Meta never reuses an id, and apps commonly treat a repeated comment or
  // media id as already handled; ids start from the clock so a restarted fake
  // does not repeat the previous run's.
  const nextId = (prefix) => `${prefix}${uniqueNumber()}`;

  // ── State helpers ──────────────────────────────────────────────────────
  function createAccount({
    username,
    name = null,
    account_type = "BUSINESS",
    followers_count = 1200,
  }) {
    const handle = String(username ?? "").replace(/^@/, "");
    if (!/^[A-Za-z0-9._]{1,30}$/.test(handle)) {
      throw new ControlError(400, "An Instagram username is required");
    }
    const account = {
      // The professional account id (IG_ID): webhook entry ids and user_id.
      id: nextId("1784"),
      // The app-scoped id Graph returns as `id` for the account.
      appScopedId: nextId("2"),
      username: handle,
      name: name ?? handle,
      account_type,
      followers_count,
      follows_count: 180,
      subscribedFields: new Set(),
      publishedAt: [],
      extraQuotaUsage: 0,
      // Calls the account's tokens may make in 24 hours (Meta's Business Use
      // Case limit), or null for no limit; and the times of recent calls.
      callLimit: null,
      callTimes: [],
      privateReplyTimes: [],
      sendTimes: [],
    };
    accounts.set(account.id, account);
    accountsByScopedId.set(account.appScopedId, account);
    return account;
  }

  function createPerson({
    username,
    name = null,
    is_user_follow_business: followsAccount = false,
    is_business_follow_user: followedByAccount = false,
  }) {
    const handle = String(username ?? "").replace(/^@/, "");
    if (!/^[A-Za-z0-9._]{1,30}$/.test(handle)) {
      throw new ControlError(400, "An Instagram username is required");
    }
    const person = {
      id: nextId("1"),
      username: handle,
      name: name ?? null,
      ...followFlags({
        is_user_follow_business: followsAccount,
        is_business_follow_user: followedByAccount,
      }),
    };
    people.set(person.id, person);
    return person;
  }

  /**
   * Whether the person follows the account and the account follows them, as
   * the User Profile API reports them.
   * https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/user-profile
   */
  function followFlags(body, current = {}) {
    const out = {};
    for (const field of [
      "is_user_follow_business",
      "is_business_follow_user",
    ]) {
      const value = body[field] ?? current[field] ?? false;
      if (typeof value !== "boolean") {
        throw new ControlError(400, `${field} must be true or false`);
      }
      out[field] = value;
    }
    return out;
  }

  function createMedia(account, fields) {
    const productType = fields.media_product_type ?? "FEED";
    if (!["FEED", "REELS", "STORY"].includes(productType)) {
      throw new ControlError(
        400,
        `Unsupported media_product_type ${productType}`,
      );
    }
    const mediaType =
      fields.media_type ?? (productType === "REELS" ? "VIDEO" : "IMAGE");
    const id = nextId("1790");
    const code = shortcode();
    const permalink =
      productType === "REELS"
        ? `https://www.instagram.com/reel/${code}/`
        : productType === "STORY"
          ? `https://www.instagram.com/stories/${account.username}/${id}/`
          : `https://www.instagram.com/p/${code}/`;
    const item = {
      id,
      owner: account.id,
      caption: productType === "STORY" ? null : (fields.caption ?? ""),
      media_product_type: productType,
      media_type: mediaType,
      permalink,
      createdAt: Date.now(),
      deleted: false,
      bytes: fields.bytes ?? null,
      contentType: fields.contentType ?? null,
      sourceUrl: fields.sourceUrl ?? null,
      containerId: fields.containerId ?? null,
    };
    media.set(id, item);
    return item;
  }

  function mediaView(item) {
    const owner = accounts.get(item.owner);
    const fileUrl = `${origin}/_fake/files/${item.id}`;
    return {
      id: item.id,
      caption: item.caption ?? undefined,
      media_product_type: item.media_product_type,
      media_type: item.media_type,
      permalink: item.permalink,
      timestamp: iso(item.createdAt),
      owner: { id: item.owner },
      username: owner?.username,
      media_url: item.children ? undefined : fileUrl,
      thumbnail_url: item.media_type === "VIDEO" ? fileUrl : undefined,
      comments_count: liveComments(item.id).length,
      like_count: 0,
      // An album's items, expanded with children{...}.
      children: item.children
        ? (sub) => ({
            data: item.children.map((id) =>
              select(mediaView(media.get(id)), sub ?? asFields(["id"])),
            ),
          })
        : undefined,
    };
  }

  function accountView(account) {
    return {
      id: account.appScopedId,
      user_id: account.id,
      username: account.username,
      name: account.name,
      account_type: account.account_type,
      profile_picture_url: `${origin}/_fake/files/avatar-${account.id}`,
      followers_count: account.followers_count,
      follows_count: account.follows_count,
      media_count: [...media.values()].filter(
        (item) =>
          item.owner === account.id &&
          !item.deleted &&
          !item.parentId &&
          item.media_product_type !== "STORY",
      ).length,
    };
  }

  function commentView(comment) {
    const item = media.get(comment.mediaId);
    return {
      id: comment.id,
      text: comment.text,
      timestamp: iso(comment.createdAt),
      hidden: comment.hidden,
      media: {
        id: comment.mediaId,
        media_product_type: item?.media_product_type,
      },
      from: { id: comment.from.id, username: comment.from.username },
      username: comment.from.username,
      parent_id: comment.parentId ?? undefined,
      like_count: 0,
      // Expanding replies{...} on a comment lists its visible replies.
      replies: comment.parentId
        ? undefined
        : (sub) => ({
            data: liveComments(comment.mediaId, comment.id)
              .sort((left, right) => compareIds(left.id, right.id))
              .map((reply) =>
                select(
                  commentView(reply),
                  sub ?? asFields(["id", "text", "timestamp"]),
                ),
              ),
          }),
    };
  }

  function compareIds(left, right) {
    const a = BigInt(left);
    const b = BigInt(right);
    return a < b ? -1 : a > b ? 1 : 0;
  }

  function containerView(container) {
    return {
      id: container.id,
      status_code: container.statusCode,
      status:
        container.statusCode === "ERROR" && container.errorSubcode
          ? `Error: Media upload has failed with error code ${container.errorSubcode}.`
          : CONTAINER_STATUS[container.statusCode],
    };
  }

  function liveComments(mediaId, parentId = null) {
    return [...comments.values()].filter(
      (comment) =>
        comment.mediaId === mediaId &&
        !comment.deleted &&
        (comment.parentId ?? null) === parentId,
    );
  }

  function record(comment, action, by, detail = {}) {
    comment.history.push({
      action,
      by,
      at: new Date().toISOString(),
      ...detail,
    });
  }

  function issueToken(account, scopes, kind) {
    const token = `IGAA${randomBytes(24).toString("base64url")}`;
    const now = Date.now();
    tokens.set(token, {
      accountId: account.id,
      scopes: new Set(scopes),
      kind,
      issuedAt: now,
      expiresAt:
        kind === "short"
          ? now + SHORT_TOKEN_MS
          : now + LONG_TOKEN_SECONDS * 1000,
      revoked: false,
    });
    return token;
  }

  function tokenFrom(request, params) {
    const header = String(request.headers.authorization ?? "");
    const bearer = header.match(/^(?:Bearer|OAuth)\s+(.+)$/i)?.[1];
    return bearer ?? params.access_token ?? null;
  }

  function requireToken(value, { kind = null } = {}) {
    if (!value) {
      throw new GraphError(400, "Invalid OAuth 2.0 Access Token", {
        type: "IGApiException",
        code: 190,
        errorData: {},
      });
    }
    const token = tokens.get(String(value));
    if (!token) {
      throw new GraphError(
        400,
        "Invalid OAuth access token - Cannot parse access token",
        { code: 190 },
      );
    }
    if (token.revoked === "app_removed") {
      throw new GraphError(
        400,
        `Error validating access token: User ${token.accountId} has not authorized application ${app.id}.`,
        { code: 190, subcode: 458 },
      );
    }
    if (token.revoked) {
      throw new GraphError(
        400,
        "Error validating access token: The session is invalid because the user logged out.",
        { code: 190, subcode: 460 },
      );
    }
    if (token.expiresAt <= Date.now()) {
      throw new GraphError(
        400,
        `Error validating access token: Session has expired on ${new Date(token.expiresAt).toUTCString()}. The current time is ${new Date().toUTCString()}.`,
        { code: 190, subcode: 463 },
      );
    }
    if (kind && token.kind !== kind) {
      throw new GraphError(
        400,
        "Invalid OAuth access token type for this request",
        {
          code: 190,
        },
      );
    }
    const account = accounts.get(token.accountId);
    if (!account)
      throw new GraphError(400, "Invalid OAuth access token", { code: 190 });
    return { token, account };
  }

  function requireScope(token, scope) {
    if (!token.scopes.has(scope)) throw missingPermission();
  }

  // ── Webhooks ───────────────────────────────────────────────────────────
  /** Meta's GET handshake before it sends anything to a callback URL. */
  async function verifyWebhook() {
    if (!webhook?.callbackUrl) return false;
    const challenge = String(randomBytes(4).readUInt32BE());
    const url = new URL(webhook.callbackUrl);
    url.searchParams.set("hub.mode", "subscribe");
    url.searchParams.set("hub.challenge", challenge);
    url.searchParams.set("hub.verify_token", webhook.verifyToken);
    try {
      const response = await fetch(url, { signal: outgoing(10_000) });
      const text = await response.text();
      webhook.verified = response.status === 200 && text === challenge;
      webhook.verifyError = webhook.verified
        ? null
        : `callback answered ${response.status} ${JSON.stringify(text.slice(0, 80))}`;
    } catch (error) {
      webhook.verified = false;
      webhook.verifyError = error.message;
    }
    if (!webhook.verified)
      log(`webhook verification failed: ${webhook.verifyError}`);
    return webhook.verified;
  }

  async function post(body) {
    const signature = createHmac("sha256", app.secret)
      .update(body)
      .digest("hex");
    const response = await fetch(webhook.callbackUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "facebookexternalua",
        "X-Hub-Signature": `sha1=${createHmac("sha1", app.secret).update(body).digest("hex")}`,
        "X-Hub-Signature-256": `sha256=${signature}`,
      },
      body,
      signal: outgoing(WEBHOOK_TIMEOUT_MS),
    });
    await response.arrayBuffer().catch(() => null);
    return response.status;
  }

  /**
   * Deliver one comments change for an account, in order. Meta sends only to
   * a verified callback and only for an account subscribed to the field, and
   * retries a failed delivery (immediately, then a few more times).
   */
  function emitComment(comment) {
    const item = media.get(comment.mediaId);
    const account = accounts.get(item.owner);
    void emitMentions({
      text: comment.text,
      mediaId: item.id,
      commentId: comment.id,
      except: [comment.from.id],
    });
    return emit(
      account,
      "comments",
      {
        id: account.id,
        time: Math.floor(Date.now() / 1000),
        changes: [
          {
            field: "comments",
            value: {
              from: { id: comment.from.id, username: comment.from.username },
              media: {
                id: item.id,
                media_product_type: item.media_product_type,
              },
              id: comment.id,
              ...(comment.parentId ? { parent_id: comment.parentId } : {}),
              text: comment.text,
            },
          },
        ],
      },
      { commentId: comment.id },
    );
  }

  /** The accounts a text tags with @username, other than `except`. */
  function mentionedAccounts(text, except = []) {
    const names = new Set(
      [...String(text ?? "").matchAll(/@([A-Za-z0-9._]{1,30})/g)].map((match) =>
        match[1].toLowerCase(),
      ),
    );
    return [...accounts.values()].filter(
      (account) =>
        names.has(account.username.toLowerCase()) &&
        !except.includes(account.id),
    );
  }

  /**
   * Meta's `mentions` change for each account a comment or caption tags, on
   * media it does not own: the comment and media ids, or the media id alone
   * for a caption.
   */
  function emitMentions({ text, mediaId, commentId = null, except = [] }) {
    const item = media.get(mediaId);
    return Promise.all(
      mentionedAccounts(text, [item.owner, ...except]).map((account) =>
        emit(
          account,
          "mentions",
          {
            id: account.id,
            time: Math.floor(Date.now() / 1000),
            changes: [
              {
                field: "mentions",
                value: commentId
                  ? { comment_id: commentId, media_id: mediaId }
                  : { media_id: mediaId },
              },
            ],
          },
          commentId ? { commentId } : { mediaId },
        ),
      ),
    );
  }

  /** The `message` object of a messaging webhook. */
  function messagePayload(message, extra = {}) {
    return {
      mid: message.mid,
      ...(message.text ? { text: message.text } : {}),
      ...(message.attachments?.length
        ? { attachments: message.attachments }
        : {}),
      ...(message.replyTo ? { reply_to: { mid: message.replyTo } } : {}),
      ...extra,
    };
  }

  /**
   * One messaging event (a message, an echo, a deletion or a reaction) for an
   * account, as Meta's messaging webhooks send it.
   */
  function emitMessaging(account, field, event, identity, at = Date.now()) {
    return emit(
      account,
      field,
      {
        // Messaging events carry milliseconds, unlike change events.
        id: account.id,
        time: at,
        messaging: [{ ...event, timestamp: at }],
      },
      identity,
    );
  }

  /** A person's message to the account, as Meta's `messages` webhook. */
  function emitMessage(account, message) {
    return emitMessaging(
      account,
      "messages",
      {
        sender: { id: message.personId },
        recipient: { id: account.id },
        message: messagePayload(message),
      },
      { messageId: message.mid },
      message.at,
    );
  }

  /**
   * A message in one account's conversations, sent by a person or by the
   * account, with the person it is with.
   */
  function conversationMessage(account, mid) {
    const received = incoming.find(
      (message) => message.accountId === account.id && message.mid === mid,
    );
    if (received) return { message: received, personId: received.personId };
    const sent = messages.find(
      (message) => message.from === account.id && message.message_id === mid,
    );
    if (sent) return { message: sent, personId: sent.recipient_id };
    return null;
  }

  /** Drop times older than a window, and say how many are left. */
  function recent(times, windowMs, now = Date.now()) {
    while (times.length && times[0] <= now - windowMs) times.shift();
    return times.length;
  }

  /**
   * Meta's X-Business-Use-Case-Usage for an account: whole-number percentages
   * of its call limit, and the minutes until a throttled account may call
   * again.
   */
  function usageHeader(account) {
    const now = Date.now();
    const used = recent(account.callTimes, CALL_WINDOW_MS, now);
    const percent = account.callLimit
      ? Math.min(100, Math.floor((used * 100) / account.callLimit))
      : 0;
    const throttled = account.callLimit != null && used >= account.callLimit;
    return JSON.stringify({
      [account.id]: [
        {
          type: "instagram",
          call_count: percent,
          total_cputime: percent,
          total_time: percent,
          estimated_time_to_regain_access: throttled
            ? Math.max(
                1,
                Math.ceil(
                  (account.callTimes[0] + CALL_WINDOW_MS - now) / 60_000,
                ),
              )
            : 0,
        },
      ],
    });
  }

  /**
   * Count a Graph call against its account's Business Use Case limit; a call
   * over the limit is refused with Meta's code 80002.
   */
  function countCall(account) {
    const used = recent(account.callTimes, CALL_WINDOW_MS);
    if (account.callLimit != null && used >= account.callLimit) {
      throw new GraphError(
        400,
        "There have been too many calls to this Instagram account. Wait a bit and try again.",
        { code: 80002 },
      );
    }
    account.callTimes.push(Date.now());
  }

  /** The account a Graph request's token belongs to, if the token is valid. */
  function tokenAccount(value) {
    try {
      return requireToken(value).account;
    } catch {
      return null;
    }
  }

  /**
   * Deliver one event for an account, in order. Meta sends only to a verified
   * callback and only for an account subscribed to the field, and retries a
   * failed delivery (immediately, then a few more times).
   */
  function emit(account, field, entry, identity) {
    const result = {
      id: deliveries.length + 1,
      ...identity,
      accountId: account.id,
      field,
      attempts: [],
    };
    deliveries.push(result);
    if (!account.subscribedFields.has(field)) {
      result.skipped = `account is not subscribed to ${field}`;
      return Promise.resolve(result);
    }
    if (!webhook?.callbackUrl) {
      result.skipped = "no webhook callback is configured";
      return Promise.resolve(result);
    }
    delivery = delivery.then(async () => {
      if (!webhook.verified && !(await verifyWebhook())) {
        result.skipped = `callback not verified: ${webhook.verifyError}`;
        return;
      }
      const body = Buffer.from(
        metaJson({ object: "instagram", entry: [entry] }),
      );
      // Every delivery's exact body, so a test can have Meta send it again.
      deliveryBodies.set(result.id, body);
      // A message's or echo's first delivery, kept for redelivery.
      if (
        identity.messageId &&
        (field === "messages" || field === "message_echoes") &&
        !sentMessaging.has(identity.messageId)
      ) {
        sentMessaging.set(identity.messageId, { body });
      }
      for (const waitMs of [0, 0, 2_000, 5_000]) {
        if (stopped) break;
        if (waitMs) await pause(waitMs);
        if (stopped) break;
        try {
          const status = await post(body);
          result.attempts.push({ at: new Date().toISOString(), status });
          if (status >= 200 && status < 300) {
            result.delivered = true;
            return;
          }
        } catch (error) {
          result.attempts.push({
            at: new Date().toISOString(),
            error: error.message,
          });
        }
      }
      result.delivered = false;
      log(`webhook delivery of ${field} failed after retries`);
    });
    return delivery.then(() => result);
  }

  function addComment({ mediaId, from, text, parentId = null, by }) {
    const item = media.get(mediaId);
    if (!item || item.deleted) throw missingObject(mediaId);
    if (item.media_product_type === "STORY") {
      throw new GraphError(400, "(#100) Stories do not accept comments", {
        code: 100,
      });
    }
    if (item.parentId) {
      throw new GraphError(
        400,
        "(#100) Comments go on the carousel, not on one of its items",
        { code: 100 },
      );
    }
    let parent = null;
    if (parentId) {
      parent = comments.get(String(parentId));
      if (!parent || parent.deleted || parent.mediaId !== mediaId) {
        throw missingObject(parentId);
      }
      // Instagram threads are one level deep: a reply to a reply joins the
      // top-level comment's thread.
      if (parent.parentId) parent = comments.get(parent.parentId);
      if (!parent || parent.deleted) throw missingObject(parentId);
      if (parent.hidden) {
        throw new GraphError(
          400,
          "(#100) Hidden comments cannot receive replies",
          {
            code: 100,
          },
        );
      }
    }
    if (typeof text !== "string" || !text.trim()) {
      throw new GraphError(400, "(#100) The parameter message is required", {
        code: 100,
      });
    }
    const comment = {
      id: nextId("1800"),
      mediaId,
      parentId: parent?.id ?? null,
      from,
      text: String(text ?? ""),
      createdAt: Date.now(),
      hidden: false,
      deleted: false,
      history: [],
    };
    comments.set(comment.id, comment);
    record(comment, "created", by);
    return comment;
  }

  // ── Publishing ─────────────────────────────────────────────────────────
  function mediaFetchUrl(value) {
    let url;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    const mapped = mediaOrigins[url.origin];
    return mapped ? new URL(`${url.pathname}${url.search}`, mapped) : url;
  }

  /** Meta downloads the media a container names before it can publish it. */
  function download(container) {
    const target = mediaFetchUrl(container.sourceUrl);
    container.download = (async () => {
      if (!target) throw new Error("media URL is not a URL");
      const response = await fetch(target, { signal: outgoing(60_000) });
      if (!response.ok) {
        container.errorSubcode = 2207052; // the media could not be fetched
        throw new Error(`media URL answered ${response.status}`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_MEDIA_BYTES) {
        throw new Error(`media size ${bytes.length} is not accepted`);
      }
      const contentType = String(response.headers.get("content-type") ?? "");
      const video = container.mediaType === "VIDEO";
      // Content publishing accepts JPEG images and MP4/MOV video only.
      if (
        video
          ? !/^video\/(mp4|quicktime)/.test(contentType)
          : !/^image\/jpeg/.test(contentType)
      ) {
        // 2207026: unsupported video format; 2207005: unsupported image format.
        container.errorSubcode = video ? 2207026 : 2207005;
        throw new Error(
          `media type ${contentType || "(none)"} is not accepted`,
        );
      }
      container.bytes = bytes;
      container.contentType = contentType;
    })().then(
      () => {
        container.downloaded = true;
      },
      (error) => {
        container.downloadError = error.message;
        log(
          `container ${container.id} media download failed: ${error.message}`,
        );
      },
    );
  }

  function refreshContainer(container) {
    if (["ERROR", "EXPIRED", "PUBLISHED"].includes(container.statusCode))
      return;
    if (container.forced) return;
    if (container.children) {
      // A carousel is ready when every item is, and fails when one does.
      if (Date.now() - container.createdAt > CONTAINER_LIFETIME_MS) {
        container.statusCode = "EXPIRED";
        return;
      }
      const items = container.children.map((id) => containers.get(id));
      for (const child of items) {
        child.polls += 1;
        refreshContainer(child);
      }
      if (
        items.some((child) => ["ERROR", "EXPIRED"].includes(child.statusCode))
      )
        container.statusCode = "ERROR";
      else if (items.every((child) => child.statusCode === "FINISHED"))
        container.statusCode = "FINISHED";
      return;
    }
    if (Date.now() - container.createdAt > CONTAINER_LIFETIME_MS) {
      container.statusCode = "EXPIRED";
      return;
    }
    if (container.downloadError) {
      container.statusCode = "ERROR";
      return;
    }
    if (
      container.downloaded &&
      container.polls >= container.pollsUntilFinished
    ) {
      container.statusCode = "FINISHED";
    }
  }

  function quotaUsage(account) {
    const since = Date.now() - PUBLISH_QUOTA.quota_duration * 1000;
    return (
      account.publishedAt.filter((at) => at > since).length +
      account.extraQuotaUsage
    );
  }

  function createContainer(account, params) {
    const kind = String(params.media_type ?? "").toUpperCase();
    if (kind === "CAROUSEL") return createCarousel(account, params);
    const carouselItem = String(params.is_carousel_item) === "true";
    if (carouselItem && !["", "IMAGE", "VIDEO"].includes(kind)) {
      throw new GraphError(
        400,
        `(#100) A carousel item must be an image or a video, not ${kind}`,
        { code: 100 },
      );
    }
    let productType;
    let mediaType;
    let sourceUrl;
    if (kind === "REELS") {
      productType = "REELS";
      mediaType = "VIDEO";
      sourceUrl = params.video_url;
    } else if (kind === "STORIES") {
      productType = "STORY";
      mediaType = params.video_url ? "VIDEO" : "IMAGE";
      sourceUrl = params.video_url ?? params.image_url;
    } else if (!kind || kind === "IMAGE") {
      productType = "FEED";
      mediaType = "IMAGE";
      sourceUrl = params.image_url;
    } else if (kind === "VIDEO" && carouselItem) {
      productType = "FEED";
      mediaType = "VIDEO";
      sourceUrl = params.video_url;
    } else {
      throw new GraphError(400, `(#100) Unsupported media_type ${kind}`, {
        code: 100,
      });
    }
    if (typeof sourceUrl !== "string" || !sourceUrl) {
      throw new GraphError(
        400,
        `(#100) The parameter ${mediaType === "VIDEO" ? "video_url" : "image_url"} is required`,
        { code: 100 },
      );
    }
    if (typeof params.caption === "string" && params.caption.length > 2200) {
      throw new GraphError(400, "The caption is too long.", {
        code: 36004,
        subcode: 2207010,
      });
    }
    const container = {
      id: nextId("1791"),
      owner: account.id,
      productType,
      mediaType,
      sourceUrl,
      // A carousel item takes no caption; the carousel carries it.
      caption:
        productType === "STORY" || carouselItem ? null : (params.caption ?? ""),
      carouselItem,
      statusCode: "IN_PROGRESS",
      createdAt: Date.now(),
      polls: 0,
      pollsUntilFinished: mediaType === "VIDEO" ? videoPollsUntilFinished : 0,
      downloaded: false,
      downloadError: null,
      forced: false,
      mediaId: null,
    };
    containers.set(container.id, container);
    // Meta downloads the media a container names. Doing the same means this
    // server fetches whatever URL the app sends, so it is opt-in: by default
    // the container is treated as downloaded without any request.
    if (downloadMedia) download(container);
    else container.downloaded = true;
    return container;
  }

  /**
   * A carousel: 2 to 10 finished-or-processing item containers of this
   * account, published together as one CAROUSEL_ALBUM post.
   */
  function createCarousel(account, params) {
    const ids = (
      Array.isArray(params.children)
        ? params.children
        : String(params.children ?? "")
            .replace(/^\[|\]$/g, "")
            .split(",")
    )
      .map((id) => String(id).replace(/"/g, "").trim())
      .filter(Boolean);
    if (ids.length < 2 || ids.length > 10) {
      throw new GraphError(
        400,
        "Carousels need at least 2 photos/videos and no more than 10.",
        { code: 100, subcode: 2207028 },
      );
    }
    const children = ids.map((id) => {
      const child = containers.get(id);
      if (!child || child.owner !== account.id) {
        throw new GraphError(
          400,
          `The media builder with creation id = ${id} does not exist or has been expired.`,
          { code: 24, subcode: 2207008 },
        );
      }
      if (!child.carouselItem || child.statusCode === "PUBLISHED") {
        throw new GraphError(
          400,
          `(#100) Container ${id} is not an unpublished carousel item`,
          { code: 100 },
        );
      }
      return child;
    });
    if (typeof params.caption === "string" && params.caption.length > 2200) {
      throw new GraphError(400, "The caption is too long.", {
        code: 36004,
        subcode: 2207010,
      });
    }
    const container = {
      id: nextId("1791"),
      owner: account.id,
      productType: "FEED",
      mediaType: "CAROUSEL_ALBUM",
      sourceUrl: null,
      caption: params.caption ?? "",
      carouselItem: false,
      children: children.map((child) => child.id),
      statusCode: "IN_PROGRESS",
      createdAt: Date.now(),
      polls: 0,
      pollsUntilFinished: 0,
      downloaded: true,
      downloadError: null,
      forced: false,
      mediaId: null,
    };
    containers.set(container.id, container);
    return container;
  }

  async function publishContainer(account, params) {
    const container = containers.get(String(params.creation_id ?? ""));
    const noContainer = () =>
      new GraphError(
        400,
        `The media builder with creation id = ${params.creation_id} does not exist or has been expired.`,
        { code: 24, subcode: 2207008 },
      );
    if (!container || container.owner !== account.id) throw noContainer();
    await container.download;
    for (const id of container.children ?? []) {
      await containers.get(id).download;
    }
    refreshContainer(container);
    if (container.carouselItem) {
      throw new GraphError(
        400,
        "(#100) A carousel item is published with its carousel, not alone",
        { code: 100 },
      );
    }
    if (container.statusCode === "EXPIRED") throw noContainer();
    if (container.statusCode === "PUBLISHED") {
      throw new GraphError(
        400,
        "(#100) The container has already been published",
        {
          code: 100,
        },
      );
    }
    if (container.statusCode !== "FINISHED") {
      throw new GraphError(400, "Media ID is not available", {
        code: 9007,
        subcode: 2207027,
      });
    }
    if (quotaUsage(account) >= PUBLISH_QUOTA.quota_total) {
      throw new GraphError(400, "(#9) Application request limit reached", {
        code: 9,
        subcode: 2207042,
      });
    }
    const item = createMedia(account, {
      media_product_type: container.productType,
      media_type: container.mediaType,
      caption: container.caption,
      bytes: container.bytes,
      contentType: container.contentType,
      sourceUrl: container.sourceUrl,
      containerId: container.id,
    });
    // A carousel's items become media of their own, listed only under it.
    item.children = (container.children ?? []).map((id) => {
      const child = containers.get(id);
      const part = createMedia(account, {
        media_product_type: "FEED",
        media_type: child.mediaType,
        caption: null,
        bytes: child.bytes,
        contentType: child.contentType,
        sourceUrl: child.sourceUrl,
        containerId: child.id,
      });
      part.parentId = item.id;
      child.statusCode = "PUBLISHED";
      child.mediaId = part.id;
      return part.id;
    });
    container.statusCode = "PUBLISHED";
    container.mediaId = item.id;
    // A carousel counts as one post against the quota.
    account.publishedAt.push(Date.now());
    void emitMentions({ text: item.caption, mediaId: item.id });
    return { id: item.id };
  }

  /**
   * mentioned_comment.comment_id(<id>){...} and mentioned_media.media_id(<id>)
   * {...}: a comment or caption on someone else's media that tags the account,
   * which its token cannot otherwise read.
   */
  function mentionedFields(account, grant, fields) {
    const out = {};
    for (const { name, sub } of fields) {
      const match = name.match(
        /^mentioned_(comment|media)\.(comment_id|media_id)\(([^)]*)\)$/,
      );
      if (!match) continue;
      requireScope(grant, SCOPES.comments);
      const [, kind, param, id] = match;
      if (
        (kind === "comment" && param !== "comment_id") ||
        (kind === "media" && param !== "media_id")
      ) {
        throw new GraphError(400, `(#100) Unknown field ${name}`, {
          code: 100,
        });
      }
      const target = kind === "comment" ? comments.get(id) : media.get(id);
      const text = kind === "comment" ? target?.text : target?.caption;
      if (
        !target ||
        target.deleted ||
        !mentionedAccounts(text).some((each) => each.id === account.id)
      ) {
        throw missingObject(id);
      }
      out[`mentioned_${kind}`] =
        kind === "comment"
          ? select(commentView(target), sub ?? asFields(["id"]))
          : select(mediaView(target), sub ?? asFields(["id"]));
    }
    return out;
  }

  // ── Graph API ──────────────────────────────────────────────────────────
  function resolveNode(id, account) {
    if (id === "me") return { kind: "account", node: account };
    if (accounts.has(id)) return { kind: "account", node: accounts.get(id) };
    if (accountsByScopedId.has(id)) {
      return { kind: "account", node: accountsByScopedId.get(id) };
    }
    if (media.has(id) && !media.get(id).deleted) {
      return { kind: "media", node: media.get(id) };
    }
    if (comments.has(id) && !comments.get(id).deleted) {
      return { kind: "comment", node: comments.get(id) };
    }
    if (containers.has(id))
      return { kind: "container", node: containers.get(id) };
    if (people.has(id)) return { kind: "person", node: people.get(id) };
    throw missingObject(id);
  }

  /** The account a node belongs to; a token reaches only its own account's. */
  function ownerOf(kind, node) {
    if (kind === "account") return node.id;
    if (kind === "media" || kind === "container") return node.owner;
    if (kind === "comment") return media.get(node.mediaId)?.owner;
    return null;
  }

  /**
   * One page of an edge. Items are in id order (ascending or descending, which
   * is creation order); a cursor names an item, and the next page starts after
   * its position, so deleting it does not break paging.
   */
  function page(
    items,
    params,
    url,
    view,
    { max = 100, descending = true } = {},
  ) {
    const requested = Number(params.limit);
    const limit = Math.min(
      Math.max(Number.isFinite(requested) && requested > 0 ? requested : 25, 1),
      max,
    );
    let rest = items;
    if (params.after) {
      const afterId = decodeCursor(params.after);
      if (!afterId || !/^\d+$/.test(afterId)) {
        throw new GraphError(400, "(#100) The after cursor is invalid", {
          code: 100,
        });
      }
      rest = items.filter((item) =>
        descending
          ? compareIds(item.id, afterId) < 0
          : compareIds(item.id, afterId) > 0,
      );
    }
    const slice = rest.slice(0, limit);
    const out = { data: slice.map(view) };
    if (slice.length) {
      out.paging = {
        cursors: {
          before: encodeCursor(slice[0].id),
          after: encodeCursor(slice.at(-1).id),
        },
      };
      if (rest.length > limit) {
        const next = new URL(url);
        next.searchParams.set("after", out.paging.cursors.after);
        out.paging.next = next.toString();
      }
    }
    return out;
  }

  async function graph({
    method,
    node: nodeId,
    edge,
    params,
    query,
    token,
    url,
  }) {
    const { token: grant, account } = requireToken(token);
    requireScope(grant, SCOPES.basic);
    const fields = parseFields(params.fields);
    const { kind, node } = resolveNode(nodeId, account);
    if (kind === "person") {
      // The User Profile API answers only for someone who has messaged the
      // account (Meta's consent rule).
      if (
        method !== "GET" ||
        edge ||
        !lastIncoming.has(`${account.id}:${node.id}`)
      ) {
        throw new GraphError(
          400,
          "User consent is required to access user profile.",
          {
            code: 100,
          },
        );
      }
      return select(
        {
          id: node.id,
          name: node.name ?? null,
          username: node.username,
          profile_pic: `${origin}/_fake/files/avatar-${node.id}`,
          follower_count: node.followers ?? 0,
          is_user_follow_business: node.is_user_follow_business,
          is_business_follow_user: node.is_business_follow_user,
          is_verified_user: false,
        },
        fields ?? asFields(["name", "username"]),
      );
    }
    if (ownerOf(kind, node) !== account.id) throw missingObject(nodeId);

    if (method === "GET" && !edge) {
      if (kind === "account") {
        const view = select(accountView(node), fields ?? []);
        Object.assign(view, mentionedFields(node, grant, fields ?? []));
        return nodeId === "me" ? { data: [view] } : view;
      }
      if (kind === "media") return select(mediaView(node), fields ?? []);
      if (kind === "comment") {
        requireScope(grant, SCOPES.comments);
        return select(commentView(node), fields ?? []);
      }
      if (kind === "container") {
        requireScope(grant, SCOPES.publish);
        node.polls += 1;
        refreshContainer(node);
        return select(containerView(node), fields ?? asFields(["status_code"]));
      }
    }

    if (kind === "media" && method === "GET" && edge === "children") {
      return {
        data: (node.children ?? []).map((id) =>
          select(mediaView(media.get(id)), fields ?? asFields(["id"])),
        ),
      };
    }
    if (kind === "account" && method === "GET" && edge === "media") {
      const items = [...media.values()]
        .filter(
          (item) =>
            item.owner === node.id &&
            !item.deleted &&
            !item.parentId &&
            item.media_product_type !== "STORY",
        )
        .sort((left, right) => compareIds(right.id, left.id));
      return page(items, params, url, (item) =>
        select(mediaView(item), fields ?? []),
      );
    }
    if (kind === "account" && edge === "subscribed_apps") {
      if (method === "GET") {
        return {
          data: node.subscribedFields.size
            ? [{ id: app.id, subscribed_fields: [...node.subscribedFields] }]
            : [],
        };
      }
      if (method === "POST") {
        const requested = String(params.subscribed_fields ?? "")
          .split(",")
          .map((field) => field.trim())
          .filter(Boolean);
        if (!requested.length) {
          throw new GraphError(
            400,
            "(#100) The parameter subscribed_fields is required",
            {
              code: 100,
            },
          );
        }
        const unknown = requested.find((field) => !WEBHOOK_FIELDS.has(field));
        if (unknown) {
          throw new GraphError(
            400,
            `(#100) Param subscribed_fields must be one of {${[...WEBHOOK_FIELDS].join(", ")}} - got "${unknown}"`,
            { code: 100 },
          );
        }
        if (
          requested.some((field) =>
            ["comments", "live_comments", "mentions"].includes(field),
          )
        )
          requireScope(grant, SCOPES.comments);
        if (
          requested.some(
            (field) => field.startsWith("message") || field === "standby",
          )
        )
          requireScope(grant, SCOPES.messages);
        for (const field of requested) node.subscribedFields.add(field);
        return { success: true };
      }
      if (method === "DELETE") {
        node.subscribedFields.clear();
        return { success: true };
      }
    }
    if (
      kind === "account" &&
      method === "GET" &&
      edge === "content_publishing_limit"
    ) {
      requireScope(grant, SCOPES.publish);
      return {
        data: [{ config: PUBLISH_QUOTA, quota_usage: quotaUsage(node) }],
      };
    }
    if (kind === "account" && method === "POST" && edge === "media") {
      requireScope(grant, SCOPES.publish);
      return { id: createContainer(node, params).id };
    }
    if (kind === "account" && method === "POST" && edge === "media_publish") {
      requireScope(grant, SCOPES.publish);
      return publishContainer(node, params);
    }
    if (kind === "account" && method === "POST" && edge === "messages") {
      // Meta accepts recipient and message as JSON objects in a JSON body, or
      // as JSON strings in a form.
      const asObject = (value, name) => {
        if (value && typeof value === "object") return value;
        try {
          const parsed = JSON.parse(String(value ?? ""));
          if (parsed && typeof parsed === "object") return parsed;
        } catch {
          // fall through
        }
        throw new GraphError(400, `(#100) The parameter ${name} is required`, {
          code: 100,
        });
      };
      const recipient = asObject(params.recipient, "recipient");
      const message = asObject(params.message, "message");
      const attachments = Array.isArray(message.attachments)
        ? message.attachments
        : message.attachment
          ? [message.attachment]
          : [];
      if (!message.text && attachments.length === 0) {
        throw new GraphError(
          400,
          "(#100) The parameter message must include text or an attachment",
          { code: 100 },
        );
      }
      const overLimit = () =>
        new GraphError(400, "Calls to this api have exceeded the rate limit.", {
          code: 613,
          subcode: 2534040,
        });
      const outsideWindow = () =>
        new GraphError(400, "This message is sent outside of allowed window.", {
          code: 10,
          subcode: 2534022,
        });
      let recipientId;
      if (recipient.comment_id != null) {
        // A private reply: one message to the commenter, within 7 days of the
        // comment, under the comments permission.
        requireScope(grant, SCOPES.comments);
        const comment = comments.get(String(recipient.comment_id));
        if (
          !comment ||
          comment.deleted ||
          media.get(comment.mediaId)?.owner !== node.id
        ) {
          throw missingObject(recipient.comment_id);
        }
        if (
          comment.privateReplied ||
          Date.now() - comment.createdAt > PRIVATE_REPLY_MS
        ) {
          throw outsideWindow();
        }
        if (
          recent(node.privateReplyTimes, 60 * 60 * 1000) >=
          PRIVATE_REPLIES_PER_HOUR
        ) {
          throw overLimit();
        }
        node.privateReplyTimes.push(Date.now());
        comment.privateReplied = true;
        recipientId = comment.from.id;
      } else {
        requireScope(grant, SCOPES.messages);
        const person = people.get(String(recipient.id ?? ""));
        if (!person) {
          throw new GraphError(400, "No matching Instagram user", {
            code: 100,
            subcode: 2534014,
          });
        }
        const last = lastIncoming.get(`${node.id}:${person.id}`);
        if (!last || Date.now() - last > MESSAGING_WINDOW_MS)
          throw outsideWindow();
        if (recent(node.sendTimes, 1000) >= SENDS_PER_SECOND) {
          throw overLimit();
        }
        node.sendTimes.push(Date.now());
        recipientId = person.id;
      }
      const sent = {
        message_id: `aWdf${randomBytes(12).toString("base64url")}`,
        recipient_id: recipientId,
        from: node.id,
        recipient,
        text: message.text ?? null,
        attachments,
        at: new Date().toISOString(),
      };
      messages.push(sent);
      // Meta echoes every message the account sends back to the app, marked
      // is_echo, to accounts subscribed to message_echoes.
      void emitMessaging(
        node,
        "message_echoes",
        {
          sender: { id: node.id },
          recipient: { id: recipientId },
          message: messagePayload(
            { mid: sent.message_id, text: sent.text, attachments },
            { is_echo: true },
          ),
        },
        { messageId: sent.message_id },
      );
      return { recipient_id: sent.recipient_id, message_id: sent.message_id };
    }

    if (kind === "media" && edge === "comments") {
      requireScope(grant, SCOPES.comments);
      if (method === "GET") {
        const items = liveComments(node.id).sort((left, right) =>
          compareIds(right.id, left.id),
        );
        return page(
          items,
          params,
          url,
          (comment) =>
            select(
              commentView(comment),
              fields ?? asFields(["text", "timestamp"]),
            ),
          { max: 50 },
        );
      }
      if (method === "POST") {
        const comment = addComment({
          mediaId: node.id,
          from: { id: account.id, username: account.username },
          text: params.message,
          by: "business",
        });
        // Meta notifies the business's own comments too.
        void emitComment(comment);
        return { id: comment.id };
      }
    }
    if (kind === "comment" && edge === "replies") {
      requireScope(grant, SCOPES.comments);
      if (method === "GET") {
        const items = liveComments(node.mediaId, node.id).sort((left, right) =>
          compareIds(left.id, right.id),
        );
        return page(
          items,
          params,
          url,
          (comment) =>
            select(
              commentView(comment),
              fields ?? asFields(["text", "timestamp"]),
            ),
          { max: 50, descending: false },
        );
      }
      if (method === "POST") {
        const reply = addComment({
          mediaId: node.mediaId,
          parentId: node.id,
          from: { id: account.id, username: account.username },
          text: params.message,
          by: "business",
        });
        void emitComment(reply);
        return { id: reply.id };
      }
    }
    if (kind === "comment" && method === "POST" && !edge) {
      requireScope(grant, SCOPES.comments);
      // `hide` is read from the query string only; the same key in a body is
      // accepted and ignored, as Meta does.
      if (!("hide" in query)) {
        throw new GraphError(400, "(#100) The parameter hide is required", {
          code: 100,
        });
      }
      const hide = String(query.hide) === "true";
      // Meta documents that a comment by the media owner cannot be hidden: the
      // call succeeds and the comment simply stays visible.
      if (node.from.id === account.id) return { success: true };
      node.hidden = hide;
      record(node, hide ? "hidden" : "unhidden", "business");
      return { success: true };
    }
    if (kind === "comment" && method === "DELETE" && !edge) {
      requireScope(grant, SCOPES.comments);
      node.deleted = true;
      record(node, "deleted", "business");
      for (const reply of liveComments(node.mediaId, node.id)) {
        reply.deleted = true;
        record(reply, "deleted", "business", { withParent: node.id });
      }
      return { success: true };
    }
    const signature = `${method} /{${kind}}${edge ? `/${edge}` : ""}`;
    if (!unimplemented.has(signature)) {
      unimplemented.add(signature);
      log(`unimplemented Graph call ${signature}`);
    }
    throw new GraphError(
      400,
      `(#100) Unsupported ${method} request on the fake Instagram`,
      {
        code: 100,
      },
    );
  }

  // ── Instagram Business Login ───────────────────────────────────────────
  function loginError(message) {
    return {
      status: 400,
      body: { error_type: "OAuthException", code: 400, error_message: message },
    };
  }

  function consentRedirect(params, decision) {
    const target = new URL(params.redirect_uri);
    if (decision.deny) {
      target.searchParams.set("error", "access_denied");
      target.searchParams.set("error_reason", "user_denied");
      target.searchParams.set(
        "error_description",
        "The user denied your request",
      );
      if (params.state) target.searchParams.set("state", params.state);
      return target.toString();
    }
    const account =
      accounts.get(String(decision.accountId)) ??
      accountsByScopedId.get(String(decision.accountId));
    if (!account)
      throw new ControlError(400, "The chosen account does not exist");
    const requested = String(params.scope ?? "")
      .split(/[,\s]+/)
      .map((scope) => scope.trim())
      .filter(Boolean);
    const granted = decision.grant
      ? requested.filter((scope) => decision.grant.includes(scope))
      : requested;
    const code = randomBytes(24).toString("base64url");
    codes.set(code, {
      accountId: account.id,
      scopes: granted,
      clientId: params.client_id,
      redirectUri: params.redirect_uri,
      expiresAt: Date.now() + 60 * 60 * 1000,
      used: false,
    });
    target.searchParams.set("code", code);
    if (params.state) target.searchParams.set("state", params.state);
    return `${target.toString()}#_`;
  }

  function validAuthorize(params) {
    if (params.client_id !== app.id) return "Invalid platform app";
    if (!app.redirectUris.includes(params.redirect_uri)) {
      return "The redirect_uri is not an allowed redirect URL for this app";
    }
    if (params.response_type !== "code") return "response_type must be code";
    if (!params.scope) return "scope is required";
    return null;
  }

  function consentPage(params) {
    const escape = (value) =>
      String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const hidden = [
      "client_id",
      "redirect_uri",
      "response_type",
      "scope",
      "state",
    ]
      .filter((key) => params[key] != null)
      .map(
        (key) =>
          `<input type="hidden" name="${key}" value="${escape(params[key])}">`,
      )
      .join("");
    const choices = [...accounts.values()]
      .map(
        (account) =>
          `<form method="post" action="/oauth/authorize">${hidden}<input type="hidden" name="account_id" value="${account.id}"><button type="submit" name="decision" value="allow">Allow as @${escape(account.username)}</button></form>`,
      )
      .join("");
    return `<!doctype html><html><head><meta charset="utf-8"><title>Fake Instagram login</title><style>body{font:15px system-ui;margin:40px auto;max-width:420px;color:#222}button{display:block;width:100%;margin:8px 0;padding:10px;font:inherit;cursor:pointer}</style></head><body><h1>Fake Instagram</h1><p>An app is asking for: ${escape(
      String(params.scope)
        .split(/[,\s]+/)
        .filter(Boolean)
        .join(", "),
    )}</p>${choices || "<p>No accounts exist yet.</p>"}<form method="post" action="/oauth/authorize">${hidden}<button type="submit" name="decision" value="cancel">Cancel</button></form></body></html>`;
  }

  async function login(method, pathname, params, request, body) {
    if (pathname === "/oauth/authorize" && method === "GET") {
      const problem = validAuthorize(params);
      if (problem)
        return { status: 400, html: `<p>Invalid Request: ${problem}</p>` };
      if (nextLogin) {
        const decision = nextLogin;
        nextLogin = null;
        return { status: 302, location: consentRedirect(params, decision) };
      }
      return { status: 200, html: consentPage(params) };
    }
    if (pathname === "/oauth/authorize" && method === "POST") {
      const form = await bodyParams(request, body);
      const problem = validAuthorize(form);
      if (problem)
        return { status: 400, html: `<p>Invalid Request: ${problem}</p>` };
      return {
        status: 302,
        location: consentRedirect(form, {
          deny: form.decision !== "allow",
          accountId: form.account_id,
        }),
      };
    }
    if (pathname === "/oauth/access_token" && method === "POST") {
      const form = await bodyParams(request, body);
      if (form.client_id !== app.id) return loginError("Invalid platform app");
      if (form.client_secret !== app.secret) {
        return loginError("Error validating client secret.");
      }
      if (form.grant_type !== "authorization_code") {
        return loginError("Unsupported grant_type");
      }
      const grant = codes.get(String(form.code ?? ""));
      if (!grant || grant.used || grant.expiresAt <= Date.now()) {
        return loginError("Matching code was not found or was already used");
      }
      if (
        grant.redirectUri !== form.redirect_uri ||
        grant.clientId !== form.client_id
      ) {
        return loginError(
          "Error validating verification code. Please make sure your redirect_uri is identical to the one you used in the OAuth dialog request",
        );
      }
      grant.used = true;
      const account = accounts.get(grant.accountId);
      return {
        status: 200,
        body: {
          data: [
            {
              access_token: issueToken(account, grant.scopes, "short"),
              user_id: account.id,
              permissions: grant.scopes.join(","),
            },
          ],
        },
      };
    }
    if (pathname === "/access_token" && method === "GET") {
      if (params.grant_type !== "ig_exchange_token") {
        throw new GraphError(400, "(#100) Unsupported grant_type", {
          code: 100,
        });
      }
      if (params.client_secret !== app.secret) {
        throw new GraphError(400, "Error validating client secret.", {
          code: 1,
        });
      }
      const { token, account } = requireToken(params.access_token, {
        kind: "short",
      });
      return {
        status: 200,
        body: {
          access_token: issueToken(account, token.scopes, "long"),
          token_type: "bearer",
          expires_in: LONG_TOKEN_SECONDS,
        },
      };
    }
    if (pathname === "/refresh_access_token" && method === "GET") {
      if (params.grant_type !== "ig_refresh_token") {
        throw new GraphError(400, "(#100) Unsupported grant_type", {
          code: 100,
        });
      }
      const { token, account } = requireToken(params.access_token, {
        kind: "long",
      });
      if (Date.now() - token.issuedAt < REFRESH_MIN_AGE_MS) {
        throw new GraphError(
          400,
          "(#100) The access token is less than 24 hours old and cannot be refreshed yet",
          {
            code: 100,
          },
        );
      }
      if (!token.scopes.has(SCOPES.basic)) throw missingPermission();
      return {
        status: 200,
        body: {
          access_token: issueToken(account, token.scopes, "long"),
          token_type: "bearer",
          expires_in: LONG_TOKEN_SECONDS,
        },
      };
    }
    return null;
  }

  // ── Test controls (/_fake/*) ───────────────────────────────────────────
  function commentState(comment) {
    return {
      ...commentView(comment),
      deleted: comment.deleted,
      history: comment.history,
      replies: [...comments.values()]
        .filter((reply) => reply.parentId === comment.id)
        .map((reply) => ({
          ...commentView(reply),
          deleted: reply.deleted,
          history: reply.history,
        })),
    };
  }

  function requireAccount(id) {
    const account =
      accounts.get(String(id)) ?? accountsByScopedId.get(String(id));
    if (!account) throw new ControlError(404, `No fake account ${id}`);
    return account;
  }

  async function control(method, parts, body) {
    const [resource, id, sub] = parts;
    if (resource === "health") return { ok: true };
    if (resource === "accounts" && method === "POST" && !id) {
      const account = createAccount(body);
      return accountView(account);
    }
    if (resource === "accounts" && id) {
      const account = requireAccount(id);
      if (!sub && method === "GET") {
        return {
          ...accountView(account),
          subscribed_fields: [...account.subscribedFields],
          quota_usage: quotaUsage(account),
          tokens: [...tokens.values()]
            .filter((token) => token.accountId === account.id)
            .map((token) => ({
              kind: token.kind,
              scopes: [...token.scopes],
              issued_at: new Date(token.issuedAt).toISOString(),
              expires_at: new Date(token.expiresAt).toISOString(),
              revoked: token.revoked,
            })),
        };
      }
      if (!sub && method === "POST") {
        if (Number.isInteger(body.extra_quota_usage)) {
          account.extraQuotaUsage = body.extra_quota_usage;
        }
        if (body.unsubscribe === true) account.subscribedFields.clear();
        if (body.call_limit !== undefined) {
          if (
            body.call_limit !== null &&
            !(Number.isInteger(body.call_limit) && body.call_limit >= 0)
          ) {
            throw new ControlError(
              400,
              "call_limit must be a whole number of calls, or null",
            );
          }
          account.callLimit = body.call_limit;
          account.callTimes = [];
        }
        return { ok: true };
      }
      if (sub === "media" && method === "POST") {
        // Only what a post made outside the app has; the stored bytes of a
        // published container are set by publishing alone.
        const item = createMedia(account, {
          caption: body.caption,
          media_product_type: body.media_product_type,
          media_type: body.media_type,
        });
        await emitMentions({ text: item.caption, mediaId: item.id });
        return mediaView(item);
      }
      if (sub === "media" && method === "GET") {
        return [...media.values()]
          .filter((item) => item.owner === account.id)
          .map((item) => ({
            ...mediaView(item),
            deleted: item.deleted,
            source_url: item.sourceUrl,
            content_type: item.contentType,
            bytes: item.bytes?.length ?? null,
            container_id: item.containerId,
          }));
      }
      if (sub === "tokens" && method === "POST") {
        // Age, expire or revoke every token of the account: a refresh needs a
        // day-old token, and a revoked one is what a removed app looks like.
        for (const token of tokens.values()) {
          if (token.accountId !== account.id) continue;
          if (Number.isFinite(body.age_hours)) {
            const shift = body.age_hours * 60 * 60 * 1000;
            token.issuedAt -= shift;
            token.expiresAt -= shift;
          }
          if (body.expire === true) token.expiresAt = Date.now() - 1;
          // revoke: the person removed the app (subcode 458);
          // logout: the session ended, e.g. a password change (subcode 460).
          if (body.revoke === true) token.revoked = "app_removed";
          if (body.logout === true) token.revoked = "logged_out";
        }
        return { ok: true };
      }
    }
    if (resource === "people" && method === "POST" && !id) {
      return createPerson(body);
    }
    if (resource === "people" && id && !sub && method === "POST") {
      const person = people.get(String(id));
      if (!person) throw new ControlError(404, `No fake person ${id}`);
      Object.assign(person, followFlags(body, person));
      return { ...person };
    }
    if (
      resource === "accounts" &&
      id &&
      sub === "outgoing" &&
      method === "POST"
    ) {
      // The owner writes to a person from the Instagram app, not through the
      // API: Meta sends only the echo (message_echoes, is_echo), and the
      // person's 24-hour window is not opened by it; the window opens on the
      // person's own messages.
      // https://developers.facebook.com/docs/instagram-platform/webhooks/
      // https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api
      // UNVERIFIED: Meta documents message_echoes for messages the business
      // sends, but not explicitly that messages typed in the Instagram app
      // produce them.
      const account = requireAccount(id);
      const person =
        body.person_id != null
          ? people.get(String(body.person_id))
          : createPerson({ username: body.username });
      if (!person)
        throw new ControlError(404, `No fake person ${body.person_id}`);
      const text = String(body.text ?? "");
      if (!text) throw new ControlError(400, "A message needs text");
      const mid = `aWdf${randomBytes(12).toString("base64url")}`;
      const webhookResult = await emitMessaging(
        account,
        "message_echoes",
        {
          sender: { id: account.id },
          recipient: { id: person.id },
          message: { mid, text, is_echo: true },
        },
        { messageId: mid },
      );
      return { mid, person_id: person.id, webhook: webhookResult };
    }
    if (
      resource === "messages" &&
      id &&
      sub === "redeliver" &&
      method === "POST"
    ) {
      // Meta retries a failed webhook delivery; the same body gives the same
      // X-Hub-Signature-256, since the signature is the HMAC of the body.
      // https://developers.facebook.com/docs/graph-api/webhooks/getting-started
      // UNVERIFIED: that a retry's body is byte-for-byte the first one's.
      const mid = decodeURIComponent(id);
      const sent = sentMessaging.get(mid);
      if (!sent)
        throw new ControlError(
          404,
          `No message ${mid} was sent to the webhook`,
        );
      if (!webhook?.callbackUrl) {
        throw new ControlError(409, "No webhook callback is configured");
      }
      const status = await post(sent.body);
      return { mid, status, delivered: status >= 200 && status < 300 };
    }
    if (
      resource === "accounts" &&
      id &&
      sub === "messages" &&
      !parts[3] &&
      method === "POST"
    ) {
      // A person messages the account. hours_ago backdates it, to test the
      // 24-hour reply window.
      const account = requireAccount(id);
      const person =
        body.person_id != null
          ? people.get(String(body.person_id))
          : createPerson({ username: body.username });
      if (!person)
        throw new ControlError(404, `No fake person ${body.person_id}`);
      const hoursAgo = Number(body.hours_ago ?? 0);
      const attachments = (
        Array.isArray(body.attachments) ? body.attachments : []
      ).map((attachment) => {
        if (!INCOMING_ATTACHMENTS.has(attachment?.type)) {
          throw new ControlError(
            400,
            `attachment type must be one of ${[...INCOMING_ATTACHMENTS].join(", ")}`,
          );
        }
        return {
          type: attachment.type,
          payload: {
            url: String(
              attachment.url ??
                `https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=${nextId("")}`,
            ),
          },
        };
      });
      const text = String(body.text ?? "");
      if (!text && attachments.length === 0) {
        throw new ControlError(400, "A message needs text or attachments");
      }
      let replyTo = null;
      if (body.reply_to != null) {
        const original = conversationMessage(account, String(body.reply_to));
        if (!original || original.personId !== person.id) {
          throw new ControlError(
            404,
            `No message ${body.reply_to} in this conversation`,
          );
        }
        replyTo = String(body.reply_to);
      }
      const message = {
        mid: `aWdf${randomBytes(12).toString("base64url")}`,
        personId: person.id,
        accountId: account.id,
        text,
        attachments,
        replyTo,
        at: Date.now() - (Number.isFinite(hoursAgo) ? hoursAgo : 0) * 3_600_000,
      };
      incoming.push(message);
      lastIncoming.set(`${account.id}:${person.id}`, message.at);
      const webhookResult = await emitMessage(account, message);
      return { mid: message.mid, person_id: person.id, webhook: webhookResult };
    }
    if (
      resource === "accounts" &&
      id &&
      sub === "messages" &&
      parts[3] &&
      parts[4] === "delete" &&
      method === "POST"
    ) {
      // The person unsends their message; Meta tells the app it was deleted.
      const account = requireAccount(id);
      const message = incoming.find(
        (entry) => entry.accountId === account.id && entry.mid === parts[3],
      );
      if (!message) {
        throw new ControlError(404, `No message ${parts[3]} from a person`);
      }
      message.deleted = true;
      return {
        webhook: await emitMessaging(
          account,
          "messages",
          {
            sender: { id: message.personId },
            recipient: { id: account.id },
            message: { mid: message.mid, is_deleted: true },
          },
          { messageId: message.mid },
        ),
      };
    }
    if (
      resource === "accounts" &&
      id &&
      sub === "messages" &&
      parts[3] &&
      parts[4] === "reactions" &&
      method === "POST"
    ) {
      // The person in the conversation reacts to a message, or takes the
      // reaction back.
      const account = requireAccount(id);
      const found = conversationMessage(account, parts[3]);
      if (!found) {
        throw new ControlError(404, `No message ${parts[3]} in a conversation`);
      }
      const action = body.action ?? "react";
      if (action !== "react" && action !== "unreact") {
        throw new ControlError(400, 'action must be "react" or "unreact"');
      }
      return {
        webhook: await emitMessaging(
          account,
          "message_reactions",
          {
            sender: { id: found.personId },
            recipient: { id: account.id },
            reaction:
              action === "react"
                ? {
                    mid: parts[3],
                    action,
                    reaction: String(body.reaction ?? "love"),
                    emoji: String(body.emoji ?? "❤️"),
                  }
                : { mid: parts[3], action },
          },
          { messageId: parts[3] },
        ),
      };
    }
    if (
      resource === "accounts" &&
      id &&
      sub === "incoming" &&
      method === "GET"
    ) {
      const account = requireAccount(id);
      return incoming.filter((message) => message.accountId === account.id);
    }
    if (resource === "media" && id) {
      const item = media.get(String(id));
      if (!item) throw new ControlError(404, `No fake media ${id}`);
      if (sub === "comments" && method === "POST") {
        const person =
          body.person_id != null
            ? people.get(String(body.person_id))
            : body.as_owner === true
              ? { id: item.owner, username: accounts.get(item.owner).username }
              : createPerson({ username: body.username });
        if (!person)
          throw new ControlError(404, `No fake person ${body.person_id}`);
        const comment = addComment({
          mediaId: item.id,
          from: { id: person.id, username: person.username },
          text: body.text,
          parentId: body.parent_id ?? null,
          by: person.id === item.owner ? "business" : "person",
        });
        const webhookResult = await emitComment(comment);
        return { ...commentState(comment), webhook: webhookResult };
      }
      if (sub === "comments" && method === "GET") {
        return [...comments.values()]
          .filter((comment) => comment.mediaId === item.id && !comment.parentId)
          .map(commentState);
      }
    }
    if (resource === "comments" && id) {
      const comment = comments.get(String(id));
      if (!comment) throw new ControlError(404, `No fake comment ${id}`);
      if (!sub && method === "GET") return commentState(comment);
      if (sub === "age" && method === "POST") {
        const hours = Number(body.hours ?? 0);
        if (!Number.isFinite(hours))
          throw new ControlError(400, "hours must be a number");
        comment.createdAt -= hours * 3_600_000;
        return commentState(comment);
      }
      if (sub === "edit" && method === "POST") {
        // The author edits their comment. Meta sends no webhook for an edit.
        comment.text = String(body.text ?? "");
        record(comment, "edited", "person");
        return commentState(comment);
      }
      if (sub === "delete" && method === "POST") {
        comment.deleted = true;
        record(comment, "deleted", "person");
        for (const reply of liveComments(comment.mediaId, comment.id)) {
          reply.deleted = true;
          record(reply, "deleted", "person", { withParent: comment.id });
        }
        return commentState(comment);
      }
    }
    if (resource === "containers" && id) {
      const container = containers.get(String(id));
      if (!container) throw new ControlError(404, `No fake container ${id}`);
      if (method === "POST" && body.status_code) {
        if (!Object.hasOwn(CONTAINER_STATUS, body.status_code)) {
          throw new ControlError(
            400,
            `Unknown status_code ${body.status_code}`,
          );
        }
        container.statusCode = body.status_code;
        container.forced = true;
      }
      return {
        ...containerView(container),
        owner: container.owner,
        media_type: container.mediaType,
        product_type: container.productType,
        source_url: container.sourceUrl,
        polls: container.polls,
        downloaded: container.downloaded,
        download_error: container.downloadError,
        media_id: container.mediaId,
      };
    }
    if (resource === "containers" && !id && method === "GET") {
      return [...containers.values()].map((container) => ({
        ...containerView(container),
        owner: container.owner,
        product_type: container.productType,
        source_url: container.sourceUrl,
        download_error: container.downloadError,
        media_id: container.mediaId,
      }));
    }
    if (
      resource === "login" &&
      sub == null &&
      id === "next" &&
      method === "POST"
    ) {
      // The answer the next login page gives, as if the person were signed
      // in and chose it: an account to allow (optionally granting only some
      // scopes), or a cancel.
      if (body.deny !== true) requireAccount(body.account_id);
      nextLogin = {
        deny: body.deny === true,
        accountId: body.account_id ?? null,
        grant: Array.isArray(body.grant) ? body.grant : null,
      };
      return { ok: true };
    }
    if (resource === "webhook" && !id && method === "GET") {
      return {
        callback_url: webhook?.callbackUrl ?? null,
        verified: webhook?.verified ?? false,
        verify_error: webhook?.verifyError ?? null,
        deliveries,
      };
    }
    if (
      resource === "webhook" &&
      id === "deliveries" &&
      sub &&
      parts[3] === "redeliver" &&
      method === "POST"
    ) {
      // Meta retries a delivery with the same body, and so the same
      // X-Hub-Signature-256.
      // https://developers.facebook.com/docs/graph-api/webhooks/getting-started
      const record = deliveries.find((entry) => entry.id === Number(sub));
      if (!record) throw new ControlError(404, `No webhook delivery ${sub}`);
      const body = deliveryBodies.get(record.id);
      if (!body) {
        throw new ControlError(
          409,
          `Delivery ${sub} was never sent: ${record.skipped ?? "not sent yet"}`,
        );
      }
      const status = await post(body);
      return {
        id: record.id,
        status,
        delivered: status >= 200 && status < 300,
      };
    }
    if (resource === "webhook" && id === "verify" && method === "POST") {
      return {
        verified: await verifyWebhook(),
        error: webhook?.verifyError ?? null,
      };
    }
    if (resource === "messages" && method === "GET") return messages;
    if (resource === "faults" && method === "POST") {
      faults.push({
        method: String(body.method ?? "").toUpperCase() || null,
        path: (() => {
          try {
            return new RegExp(String(body.path ?? ".*"));
          } catch {
            throw new ControlError(
              400,
              "fault path is not a valid regular expression",
            );
          }
        })(),
        status: (() => {
          const status = Number(body.status ?? 500);
          if (!Number.isInteger(status) || status < 400 || status > 599) {
            throw new ControlError(
              400,
              "fault status must be an HTTP error status (400-599)",
            );
          }
          return status;
        })(),
        message: String(
          body.message ??
            "An unexpected error has occurred. Please retry your request later.",
        ),
        code: Number(body.code ?? 2),
        subcode: body.subcode == null ? undefined : Number(body.subcode),
        times: Number(body.times ?? 1),
        // drop: the change is made and the connection closes with no answer.
        apply: body.apply === true || body.drop === true,
        drop: body.drop === true,
      });
      return { faults: faults.length };
    }
    if (resource === "faults" && method === "DELETE") {
      faults = [];
      return { ok: true };
    }
    if (resource === "calls" && method === "GET") {
      return { calls, unimplemented: [...unimplemented] };
    }
    throw new ControlError(
      404,
      `Unknown fake control ${method} /${parts.join("/")}`,
    );
  }

  // ── HTTP ───────────────────────────────────────────────────────────────
  function sendJson(response, status, payload) {
    response.writeHead(status, {
      "Content-Type": "application/json; charset=UTF-8",
    });
    response.end(JSON.stringify(payload));
  }

  function sendGraphError(response, error) {
    if (error.code === 190) {
      // Meta names the token problem in a www-authenticate header too.
      response.setHeader(
        "www-authenticate",
        `OAuth "Facebook Platform" "${error.type === "IGApiException" ? "invalid_request" : "invalid_token"}" "${error.message.replace(/"/g, "'").replace(/[^\x20-\x7e]/g, "?")}"`,
      );
    }
    sendJson(response, error.status, {
      error: {
        message: error.message,
        type: error.type,
        code: error.code,
        ...(error.subcode ? { error_subcode: error.subcode } : {}),
        ...(error.errorData ? { error_data: error.errorData } : {}),
        fbtrace_id: randomBytes(8).toString("base64url"),
      },
    });
  }

  function takeFault(method, pathname) {
    const fault = faults.find(
      (entry) =>
        entry.times > 0 &&
        (!entry.method || entry.method === method) &&
        entry.path.test(pathname),
    );
    if (fault) fault.times -= 1;
    return fault ?? null;
  }

  function serveFile(response, id) {
    const item = media.get(id);
    if (item?.bytes) {
      response.writeHead(200, { "Content-Type": item.contentType });
      response.end(item.bytes);
      return;
    }
    const hue = Number(BigInt(id.replace(/\D/g, "") || "0") % 360n);
    const label = item
      ? `${item.media_product_type} ${id.slice(-4)}`
      : "avatar";
    response.writeHead(200, { "Content-Type": "image/svg+xml" });
    response.end(
      `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><rect width="320" height="320" fill="hsl(${hue},55%,55%)"/><text x="160" y="170" font-family="sans-serif" font-size="28" fill="#fff" text-anchor="middle">${label}</text></svg>`,
    );
  }

  const server = http.createServer(async (request, response) => {
    try {
      let url;
      try {
        // Joined to the origin so a path like //v25.0/me is never read as a host.
        url = new URL(origin + request.url);
        decodeURIComponent(url.pathname);
      } catch {
        sendJson(response, 400, {
          error: {
            message: "Malformed request path",
            type: "OAuthException",
            code: 1,
          },
        });
        return;
      }
      const body = await readBody(request);
      if (url.pathname.startsWith("/_fake/files/")) {
        serveFile(
          response,
          decodeURIComponent(url.pathname.slice("/_fake/files/".length)),
        );
        return;
      }
      if (url.pathname.startsWith("/_fake/")) {
        const parts = url.pathname
          .slice("/_fake/".length)
          .split("/")
          .filter(Boolean);
        try {
          let payload = {};
          if (body.length) {
            try {
              payload = JSON.parse(body.toString("utf8"));
            } catch {
              throw new ControlError(400, "control body is not valid JSON");
            }
            if (
              !payload ||
              typeof payload !== "object" ||
              Array.isArray(payload)
            ) {
              throw new ControlError(400, "control body must be a JSON object");
            }
          }
          sendJson(
            response,
            200,
            await control(request.method, parts, payload),
          );
        } catch (error) {
          sendJson(response, error.status ?? 500, { error: error.message });
        }
        return;
      }
      const query = Object.fromEntries(url.searchParams.entries());
      const graphPath = url.pathname.match(
        /^\/(?:(v\d+\.\d+)\/)?([^/]+)(?:\/([^/]+))?\/?$/,
      );
      calls.push({
        method: request.method,
        path: url.pathname,
        params: Object.keys(query).filter((key) => key !== "access_token"),
        at: new Date().toISOString(),
      });
      const loginPaths = [
        "/oauth/authorize",
        "/oauth/access_token",
        "/access_token",
        "/refresh_access_token",
      ];
      const loginAnswer =
        graphPath && !loginPaths.includes(url.pathname)
          ? null
          : await login(
              request.method,
              url.pathname,
              query,
              request,
              body,
            ).catch((error) => {
              if (error instanceof GraphError) return { graphError: error };
              throw error;
            });
      if (loginAnswer?.graphError) {
        sendGraphError(response, loginAnswer.graphError);
        return;
      }
      if (loginAnswer) {
        if (loginAnswer.location) {
          response.writeHead(loginAnswer.status, {
            Location: loginAnswer.location,
          });
          response.end();
        } else if (loginAnswer.html) {
          response.writeHead(loginAnswer.status, {
            "Content-Type": "text/html; charset=utf-8",
          });
          response.end(loginAnswer.html);
        } else {
          sendJson(response, loginAnswer.status, loginAnswer.body);
        }
        return;
      }
      if (!graphPath || loginPaths.includes(url.pathname)) {
        // Meta checks the access token before the path or version, so a
        // request without a valid token gets the token error on any path.
        requireToken(tokenFrom(request, query));
        sendJson(response, 404, {
          error: { message: "Unknown path", code: 803 },
        });
        return;
      }
      const params =
        request.method === "GET" || request.method === "DELETE"
          ? query
          : { ...query, ...(await bodyParams(request, body)) };
      const fault = takeFault(request.method, url.pathname);
      // Every call a valid token makes counts against its account's limit and
      // is answered with the account's usage, as Meta does.
      const caller = tokenAccount(tokenFrom(request, params));
      if (caller) {
        try {
          countCall(caller);
        } finally {
          response.setHeader("X-Business-Use-Case-Usage", usageHeader(caller));
        }
      }
      if (fault && !fault.apply) {
        sendGraphError(
          response,
          new GraphError(fault.status, fault.message, {
            code: fault.code,
            subcode: fault.subcode,
          }),
        );
        return;
      }
      const result = await graph({
        method: request.method,
        node: decodeURIComponent(graphPath[2]),
        edge: graphPath[3] ? decodeURIComponent(graphPath[3]) : null,
        params,
        query,
        token: tokenFrom(request, params),
        url: url.toString(),
      });
      if (fault?.drop) {
        // The change was made, and the connection closes with no answer.
        request.socket.destroy();
        return;
      }
      if (fault) {
        // The change was made; the answer to it is lost.
        sendGraphError(
          response,
          new GraphError(fault.status, fault.message, {
            code: fault.code,
            subcode: fault.subcode,
          }),
        );
        return;
      }
      sendJson(response, 200, result);
    } catch (error) {
      if (error instanceof GraphError) {
        sendGraphError(response, error);
        return;
      }
      if (error instanceof ControlError) {
        sendJson(response, error.status, { error: error.message });
        return;
      }
      log(`internal error: ${error.stack ?? error.message}`);
      if (response.headersSent) {
        response.destroy();
        return;
      }
      sendJson(response, 500, { error: { message: error.message, code: 1 } });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  origin = `http://${host.includes(":") ? `[${host}]` : host}:${server.address().port}`;
  /** Run a control action in-process, with the same checks as /_fake/*. */
  async function act(method, path, body = {}) {
    try {
      return structuredClone(await control(method, path.split("/"), body));
    } catch (error) {
      if (error instanceof ControlError || error instanceof GraphError) {
        throw new Error(error.message);
      }
      throw error;
    }
  }

  return {
    origin,
    createAccount: (fields) => act("POST", "accounts", fields),
    getAccount: (accountId) => act("GET", `accounts/${accountId}`),
    postMedia: (accountId, fields = {}) =>
      act("POST", `accounts/${accountId}/media`, fields),
    getMedia: (accountId) => act("GET", `accounts/${accountId}/media`),
    createPerson: (fields) => act("POST", "people", fields),
    comment: (mediaId, fields) =>
      act("POST", `media/${mediaId}/comments`, fields),
    getComments: (mediaId) => act("GET", `media/${mediaId}/comments`),
    getComment: (commentId) => act("GET", `comments/${commentId}`),
    editComment: (commentId, text) =>
      act("POST", `comments/${commentId}/edit`, { text }),
    deleteComment: (commentId) => act("POST", `comments/${commentId}/delete`),
    setNextLogin: (answer) => act("POST", "login/next", answer),
    changeTokens: (accountId, change) =>
      act("POST", `accounts/${accountId}/tokens`, change),
    setQuotaUsage: (accountId, used) =>
      act("POST", `accounts/${accountId}`, { extra_quota_usage: used }),
    setContainerStatus: (containerId, statusCode) =>
      act("POST", `containers/${containerId}`, { status_code: statusCode }),
    getContainer: (containerId) => act("GET", `containers/${containerId}`),
    getContainers: () => act("GET", "containers"),
    getWebhook: () => act("GET", "webhook"),
    verifyWebhook: async () => (await act("POST", "webhook/verify")).verified,
    getMessages: () => act("GET", "messages"),
    sendMessageToAccount: (accountId, fields) =>
      act("POST", `accounts/${accountId}/messages`, fields),
    updatePerson: (personId, fields) =>
      act("POST", `people/${personId}`, fields),
    sendAsOwner: (accountId, fields) =>
      act("POST", `accounts/${accountId}/outgoing`, fields),
    redeliverWebhook: (deliveryId) =>
      act("POST", `webhook/deliveries/${deliveryId}/redeliver`),
    redeliverMessage: (mid) =>
      act("POST", `messages/${encodeURIComponent(mid)}/redeliver`),
    deleteMessage: (accountId, mid) =>
      act("POST", `accounts/${accountId}/messages/${mid}/delete`),
    reactToMessage: (accountId, mid, reaction = {}) =>
      act("POST", `accounts/${accountId}/messages/${mid}/reactions`, reaction),
    setCallLimit: (accountId, limit) =>
      act("POST", `accounts/${accountId}`, { call_limit: limit }),
    ageComment: (commentId, hours) =>
      act("POST", `comments/${commentId}/age`, { hours }),
    addFault: (fault) => act("POST", "faults", fault),
    clearFaults: () => act("DELETE", "faults"),
    getCalls: () => act("GET", "calls"),
    stop: async () => {
      stopped = true;
      shutdown.abort();
      await delivery.catch(() => {});
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
