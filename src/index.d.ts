export interface AppConfig {
  /** The Meta app id (client_id). */
  id: string;
  /** The app secret: signs webhooks and authenticates the code exchange. */
  secret: string;
  /** Redirect URIs the login flow may send the person back to. */
  redirectUris: string[];
}

export interface TestServerOptions {
  app: AppConfig;
  /** Default 0 (any free port). */
  port?: number;
  /** Default "127.0.0.1". */
  host?: string;
  /** Where comment webhooks go, after Meta's GET verification handshake passes. */
  webhook?: { callbackUrl: string; verifyToken: string } | null;
  /**
   * Fetch the media URL a publishing container names, as Meta does, and fail
   * the container when it is not a JPEG image or MP4/MOV video. Off by default,
   * because it makes this server request whatever URL the app sends.
   */
  downloadMedia?: boolean;
  /** Rewrite media URL origins before downloading, e.g. a public CDN to a local server. */
  mediaOrigins?: Record<string, string>;
  /** Status polls a video container needs before it reports FINISHED. Default 1. */
  videoPollsUntilFinished?: number;
  log?: (line: string) => void;
}

/** Plain objects in the Graph API's own shapes. */
export type GraphObject = { id: string; [field: string]: unknown };

export interface CommentState extends GraphObject {
  text: string;
  hidden: boolean;
  deleted: boolean;
  parent_id?: string;
  /** Who did what to the comment: created, hidden, unhidden, edited, deleted. */
  history: Array<{
    action: string;
    by: string;
    at: string;
    [detail: string]: unknown;
  }>;
  replies?: CommentState[];
  /** On comments created by comment(): what happened to the webhook for it. */
  webhook?: WebhookDelivery;
}

export interface WebhookDelivery {
  /** Pass to redeliverWebhook to send this delivery again. */
  id: number;
  field:
    | "comments"
    | "mentions"
    | "messages"
    | "message_echoes"
    | "message_reactions"
    | "messaging_seen"
    | "messaging_postbacks"
    | "messaging_referral"
    | "message_edit";
  commentId?: string;
  messageId?: string;
  mediaId?: string;
  accountId: string;
  attempts: Array<{ at: string; status?: number; error?: string }>;
  delivered?: boolean;
  skipped?: string;
  /** Held by holdWebhooks() and not sent yet. */
  held?: boolean;
}

/** An attachment a person sends, in Meta's webhook types. */
export interface IncomingAttachment {
  type:
    | "image"
    | "video"
    | "audio"
    | "file"
    | "share"
    | "ig_post"
    | "story_mention"
    | "ig_reel"
    | "reel"
    | "ephemeral";
  /** Used as given. Without it the file is served here and expires. */
  url?: string;
  /** How long the served URL works. Default 24 hours. */
  expires_in_ms?: number;
  /** The served URL answers 404 from the start. */
  unavailable?: boolean;
  /** ig_post: the shared post's media id. */
  ig_post_media_id?: string;
  /** ig_reel and reel: the reel's video id. */
  reel_video_id?: string;
  /** ig_post, ig_reel and reel: the title. */
  title?: string;
  /** story_mention: the story's id, shown through the Conversations API. */
  story_id?: string;
  /** image: the size the Conversations API reports. Default 1080. */
  width?: number;
  height?: number;
}

/** A message seeded into a conversation's history, without any webhook. */
export interface SeedMessage {
  /** Default: a generated mid. Unique within the account only. */
  id?: string;
  from: "customer" | "business";
  text?: string;
  /** Milliseconds or an ISO date. Default: now on the server's clock. */
  created_time?: number | string;
  attachments?: IncomingAttachment[];
  /** The mid of an earlier message in the conversation it answers. */
  reply_to?: string;
  reply_to_story?: { url: string; id?: string };
  reactions?: Array<{
    by: "customer" | "business";
    reaction?: string;
    emoji?: string;
  }>;
  is_unsupported?: boolean;
  /** A business message the person has seen, or a person's message the business has. */
  seen?: boolean;
}

/** A conversation as the account's state shows it to a test. */
export interface ConversationState {
  id: string;
  customer_id: string;
  folder: "requests" | "general";
  updated_time: string | null;
  /** Oldest first, unsent ones included. */
  messages: Array<{
    id: string;
    from: "customer" | "business";
    text: string | null;
    created_time: string;
    attachments: Array<{
      id: string;
      type: string;
      url: string | null;
      expires_at: string | null;
    }>;
    reply_to: string | null;
    reply_to_story: { url: string; id?: string } | null;
    reactions: Array<{
      by: "customer" | "business";
      reaction: string;
      emoji: string;
    }>;
    is_unsupported: boolean;
    deleted: boolean;
    edits: number;
    seen_by_customer: boolean;
    seen_by_business: boolean;
  }>;
}

/** Someone who messages one account, under an id scoped to that account. */
export interface Customer {
  id: string;
  username: string;
  name: string | null;
  is_user_follow_business: boolean;
  is_business_follow_user: boolean;
  /** An admin, developer or tester of the app. */
  has_app_role: boolean;
}

/** The app's standing with Meta. */
export interface AppAccess {
  mode: "live" | "development";
  access_level: "standard" | "advanced";
  business_verified: boolean;
  /** The Human Agent feature, approved in App Review. */
  human_agent: boolean;
}

/**
 * The running server. Point the app's Instagram hosts at `origin`. The actions
 * below are also available over HTTP under `${origin}/_fake/`.
 */
export interface TestServer {
  origin: string;
  /** A professional account the app can log in as. */
  createAccount(fields: {
    username: string;
    name?: string;
    /** Professional accounts only. Default BUSINESS. */
    account_type?: "BUSINESS" | "MEDIA_CREATOR";
    followers_count?: number;
  }): Promise<GraphObject>;
  /** The account with its subscriptions, quota usage and tokens. */
  getAccount(accountId: string): Promise<GraphObject>;
  /** Media the account posted outside the app. */
  postMedia(
    accountId: string,
    fields?: {
      caption?: string;
      media_product_type?: "FEED" | "REELS" | "STORY";
      media_type?: string;
    },
  ): Promise<GraphObject>;
  getMedia(accountId: string): Promise<GraphObject[]>;
  /**
   * Someone who can comment or message. Their id is an Instagram-scoped id
   * (IGSID). The follow flags default to false and show in the User Profile
   * API once the person has messaged the account.
   */
  createPerson(fields: {
    username: string;
    name?: string;
    is_user_follow_business?: boolean;
    is_business_follow_user?: boolean;
  }): Promise<{
    id: string;
    username: string;
    name: string | null;
    is_user_follow_business: boolean;
    is_business_follow_user: boolean;
  }>;
  /** Change whether the person follows the account, or the account them. */
  updatePerson(
    personId: string,
    fields: {
      is_user_follow_business?: boolean;
      is_business_follow_user?: boolean;
    },
  ): Promise<unknown>;
  /**
   * The owner writes to a person from the Instagram app: only a
   * message_echoes webhook, and no 24-hour window for the app.
   */
  sendAsOwner(
    accountId: string,
    fields: { text: string; person_id?: string; username?: string },
  ): Promise<{ mid: string; person_id: string; webhook: WebhookDelivery }>;
  /**
   * Send any webhook delivery again, by its id, with the same body and
   * signature; or unsigned ("missing") or wrongly signed ("invalid").
   */
  redeliverWebhook(
    deliveryId: number,
    options?: { signature?: "valid" | "missing" | "invalid" },
  ): Promise<{ id: number; status: number; delivered: boolean }>;
  /** Send a message's or echo's webhook again, with the same body and signature. */
  redeliverMessage(
    mid: string,
  ): Promise<{ mid: string; status: number; delivered: boolean }>;
  /**
   * The person messages the account (a new person when only username is given),
   * opening the 24-hour window for the app to reply. hours_ago backdates it.
   * A message needs text or attachments; reply_to is the mid it answers.
   */
  sendMessageToAccount(
    accountId: string,
    fields: {
      text?: string;
      attachments?: IncomingAttachment[];
      reply_to?: string;
      /** A reply to the account's story. */
      reply_to_story?: { url: string; id?: string };
      is_unsupported?: boolean;
      /** A new person scoped to this account. */
      username?: string;
      person_id?: string;
      hours_ago?: number;
    },
  ): Promise<{
    mid: string;
    person_id: string;
    conversation_id: string;
    attachments: Array<{ type: string; url: string | null }>;
    webhook: WebhookDelivery;
  }>;
  /** The person unsends their message; the app gets it with is_deleted. */
  deleteMessage(
    accountId: string,
    mid: string,
  ): Promise<{ webhook: WebhookDelivery }>;
  /**
   * The person in the conversation reacts to a message (default "love", ❤️),
   * or takes the reaction back with action "unreact".
   */
  reactToMessage(
    accountId: string,
    mid: string,
    reaction?: {
      action?: "react" | "unreact";
      reaction?: string;
      emoji?: string;
    },
  ): Promise<{ webhook: WebhookDelivery }>;
  /**
   * Calls the account's tokens may make in 24 hours before Meta's code 80002,
   * or null for no limit. Setting it starts the count again.
   */
  setCallLimit(accountId: string, limit: number | null): Promise<unknown>;
  /** Backdate a comment by some hours, e.g. past the 7-day private-reply limit. */
  ageComment(commentId: string, hours: number): Promise<CommentState>;
  /**
   * A comment on the media: by a new person (username), an existing one
   * (person_id) or the account itself (as_owner), optionally replying to
   * parent_id. Resolves after the webhook for it was sent, skipped or failed.
   */
  comment(
    mediaId: string,
    fields: {
      text: string;
      username?: string;
      person_id?: string;
      as_owner?: boolean;
      parent_id?: string;
    },
  ): Promise<CommentState>;
  /** Top-level comments on the media, with their replies, including deleted ones. */
  getComments(mediaId: string): Promise<CommentState[]>;
  getComment(commentId: string): Promise<CommentState>;
  /** The author edits the comment. Meta sends no webhook for an edit. */
  editComment(commentId: string, text: string): Promise<CommentState>;
  /** The author deletes the comment. */
  deleteComment(commentId: string): Promise<CommentState>;
  /** How the next login page answers: allow as an account (optionally only some scopes), or deny. */
  setNextLogin(answer: {
    account_id?: string;
    grant?: string[];
    deny?: boolean;
  }): Promise<unknown>;
  /** Age, expire or revoke every token of the account. */
  changeTokens(
    accountId: string,
    change: {
      age_hours?: number;
      expire?: boolean;
      /** The person removed the app: subcode 458. */
      revoke?: boolean;
      /** The session ended, e.g. a password change: subcode 460. */
      logout?: boolean;
    },
  ): Promise<unknown>;
  /** Count extra publications against the account's quota. */
  setQuotaUsage(accountId: string, used: number): Promise<unknown>;
  /** Force a publishing container into a status. */
  setContainerStatus(
    containerId: string,
    statusCode: "IN_PROGRESS" | "FINISHED" | "PUBLISHED" | "EXPIRED" | "ERROR",
  ): Promise<GraphObject>;
  getContainer(containerId: string): Promise<GraphObject>;
  getContainers(): Promise<GraphObject[]>;
  /** The webhook callback, whether it passed verification, and every delivery. */
  getWebhook(): Promise<{
    callback_url: string | null;
    verified: boolean;
    verify_error: string | null;
    deliveries: WebhookDelivery[];
  }>;
  /** Run Meta's verification handshake against the callback now. */
  verifyWebhook(): Promise<boolean>;
  /** Messages the app sent. */
  getMessages(): Promise<GraphObject[]>;
  /**
   * Fail the next matching Graph calls: path is a regular expression; with
   * apply, the change is made but the answer is still an error.
   */
  addFault(fault: {
    method?: string;
    path?: string;
    status?: number;
    message?: string;
    code?: number;
    subcode?: number;
    times?: number;
    apply?: boolean;
    /** The change is made and the connection closes with no answer. */
    drop?: boolean;
  }): Promise<unknown>;
  clearFaults(): Promise<unknown>;
  /**
   * Every Graph call (method, path, parameter names, status) and every
   * webhook attempt, with no tokens, signatures or message content; and the
   * Graph calls this server does not model.
   */
  getCalls(): Promise<{
    calls: Array<{
      method: string;
      path: string;
      params: string[];
      at: string;
      status?: number | null;
      dropped?: boolean;
    }>;
    unimplemented: string[];
    webhooks: Array<{
      delivery_id: number;
      field: string;
      account_id: string;
      at: string;
      signature: "valid" | "missing" | "invalid";
      status?: number;
      error?: string;
    }>;
  }>;
  /** Move the server's clock forward. Returns the new time. */
  advanceClock(ms: number): Promise<{ now: string }>;
  getAppAccess(): Promise<AppAccess>;
  /**
   * Change the app's mode, access level, Business Verification or Human
   * Agent feature. Advanced Access and Human Agent need a verified business.
   */
  setAppAccess(access: Partial<AppAccess>): Promise<AppAccess>;
  /** Grant or revoke permissions on every token of the account. */
  setPermissions(
    accountId: string,
    change: { grant?: string[]; revoke?: string[] },
  ): Promise<unknown>;
  /** Someone who can message the account, with an id scoped to it. */
  createCustomer(
    accountId: string,
    fields: {
      username: string;
      id?: string;
      name?: string;
      has_app_role?: boolean;
      is_user_follow_business?: boolean;
      is_business_follow_user?: boolean;
    },
  ): Promise<Customer>;
  updateCustomer(
    accountId: string,
    customerId: string,
    fields: {
      has_app_role?: boolean;
      is_user_follow_business?: boolean;
      is_business_follow_user?: boolean;
    },
  ): Promise<Customer>;
  /** A conversation with its history, without webhooks. */
  seedConversation(
    accountId: string,
    fields: {
      id?: string;
      customer_id?: string;
      username?: string;
      folder?: "requests" | "general";
      messages?: SeedMessage[];
    },
  ): Promise<ConversationState>;
  addConversationMessages(
    accountId: string,
    conversationId: string,
    messages: SeedMessage[],
  ): Promise<ConversationState>;
  getConversation(
    accountId: string,
    conversationId: string,
  ): Promise<ConversationState>;
  getConversations(accountId: string): Promise<ConversationState[]>;
  setConversationFolder(
    accountId: string,
    conversationId: string,
    folder: "requests" | "general",
  ): Promise<ConversationState>;
  /** The person sees the account's message: messaging_seen. */
  markSeenByCustomer(
    accountId: string,
    mid: string,
  ): Promise<{ webhook: WebhookDelivery }>;
  /** The person edits their message: message_edit. */
  editMessage(
    accountId: string,
    mid: string,
    text: string,
  ): Promise<{ num_edit: number; webhook: WebhookDelivery }>;
  /** The person taps an icebreaker or button: messaging_postbacks. */
  sendPostback(
    accountId: string,
    fields: {
      title: string;
      payload: string;
      person_id?: string;
      username?: string;
    },
  ): Promise<{ person_id: string; webhook: WebhookDelivery }>;
  /** The person opens the conversation from an ig.me link: messaging_referral. */
  sendReferral(
    accountId: string,
    fields: {
      ref: string;
      source?: string;
      person_id?: string;
      username?: string;
    },
  ): Promise<{ person_id: string; webhook: WebhookDelivery }>;
  /** Hold webhook deliveries until releaseWebhooks(). */
  holdWebhooks(): Promise<unknown>;
  /** Send the held deliveries in the order made, in reverse, or by delivery id. */
  releaseWebhooks(options?: {
    order?: "sent" | "reverse" | number[];
  }): Promise<WebhookDelivery[]>;
  /**
   * Forget conversations, messages, account-scoped people, attachments and
   * held webhooks. Accounts, tokens, media, comments and logs stay.
   */
  resetMessaging(): Promise<unknown>;
  stop(): Promise<void>;
}

export declare function startTestServer(
  options: TestServerOptions,
): Promise<TestServer>;
