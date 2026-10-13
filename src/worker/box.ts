// One Durable Object per secret. A Durable Object handles one request at a time, so "read once" is atomic here.

import { DurableObject } from "cloudflare:workers";
import type { ItemKind, ItemState, PublicItem } from "../shared/protocol";

export interface StoredItem {
  id: string;
  kind: ItemKind;
  state: ItemState;
  verified: boolean;
  label: string | null;
  recipient: string | null;
  ciphertext: string | null;
  authHash: string;
  manageHash: string | null;
  createdAt: number;
  expiresAt: number;
  filledAt: number | null;
  readAt: number | null;
  /** When the record itself goes. Equals expiresAt, except that a read keeps its "opened at" receipt a week longer. */
  retainUntil?: number;
}

/** How long "this link was opened at T" stays visible after a read: the interception signal the pages promise. */
const RECEIPT_MS = 7 * 24 * 60 * 60 * 1000;

export type BoxResult<T> = { ok: true; value: T } | { ok: false; error: "not_found" | "forbidden" | "conflict" };

const KEY = "item";

function sameHash(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  return left.byteLength === right.byteLength && crypto.subtle.timingSafeEqual(left, right);
}

export class SecretBox extends DurableObject {
  private async load(now: number): Promise<StoredItem | null> {
    const item = await this.ctx.storage.get<StoredItem>(KEY);
    if (!item) return null;
    const unread = item.state === "open" || item.state === "filled";
    if (now >= (item.retainUntil ?? item.expiresAt) || (unread && now >= item.expiresAt)) {
      await this.ctx.storage.deleteAll();
      return null;
    }
    return item;
  }

  async create(item: StoredItem): Promise<boolean> {
    if (await this.ctx.storage.get(KEY)) return false;
    await this.ctx.storage.put(KEY, item);
    await this.ctx.storage.setAlarm(item.expiresAt);
    return true;
  }

  async describe(now: number): Promise<Omit<PublicItem, "verifiedName"> | null> {
    const item = await this.load(now);
    if (!item) return null;
    return {
      id: item.id,
      kind: item.kind,
      state: item.state,
      verified: item.verified,
      label: item.label,
      recipient: item.kind === "request" && item.state === "open" ? item.recipient : null,
      createdAt: item.createdAt,
      expiresAt: item.expiresAt,
      filledAt: item.filledAt,
      readAt: item.readAt,
    };
  }

  /** A request's sender delivers the ciphertext. Only the first delivery counts. */
  async fill(ciphertext: string, now: number): Promise<BoxResult<number>> {
    const item = await this.load(now);
    if (!item || item.kind !== "request") return { ok: false, error: "not_found" };
    if (item.state !== "open") return { ok: false, error: "conflict" };
    await this.ctx.storage.put(KEY, { ...item, ciphertext, state: "filled", filledAt: now });
    return { ok: true, value: now };
  }

  /** Hands out the ciphertext once and deletes it in the same step. */
  async open(authHash: string, now: number): Promise<BoxResult<string>> {
    const item = await this.load(now);
    if (!item) return { ok: false, error: "not_found" };
    if (!sameHash(authHash, item.authHash)) return { ok: false, error: "forbidden" };
    const readable = item.kind === "send" ? item.state === "open" : item.state === "filled";
    if (!readable || !item.ciphertext) return { ok: false, error: "conflict" };
    const retainUntil = Math.max(item.expiresAt, now + RECEIPT_MS);
    await this.ctx.storage.put(KEY, { ...item, ciphertext: null, state: "read", readAt: now, retainUntil });
    await this.ctx.storage.setAlarm(retainUntil);
    return { ok: true, value: item.ciphertext };
  }

  /**
   * Deletes the secret now. One-time links: only their creator (manage token). Requests: only the requester.
   * `hash` null means the owner token (abuse takedown), which may revoke anything.
   */
  async revoke(hash: string | null, now: number): Promise<BoxResult<ItemState>> {
    const item = await this.load(now);
    if (!item) return { ok: false, error: "not_found" };
    const expected = item.kind === "send" ? item.manageHash : item.authHash;
    if (hash !== null && (expected === null || !sameHash(hash, expected))) return { ok: false, error: "forbidden" };
    if (item.state === "read" || item.state === "revoked" || item.state === "removed") return { ok: true, value: item.state };
    const state = hash === null ? "removed" : "revoked"; // null = operator takedown, shown to visitors as an abuse removal
    await this.ctx.storage.put(KEY, { ...item, ciphertext: null, state });
    return { ok: true, value: state };
  }

  /** The requester rejects an answer (wrong value, or someone else answered first) and waits for a new one. */
  async reopen(authHash: string, now: number): Promise<BoxResult<ItemState>> {
    const item = await this.load(now);
    if (!item || item.kind !== "request") return { ok: false, error: "not_found" };
    if (!sameHash(authHash, item.authHash)) return { ok: false, error: "forbidden" };
    if (item.state !== "filled" && item.state !== "read") return { ok: false, error: "conflict" };
    if (now >= item.expiresAt) return { ok: false, error: "not_found" };
    await this.ctx.storage.put(KEY, { ...item, ciphertext: null, state: "open", filledAt: null, readAt: null, retainUntil: item.expiresAt });
    await this.ctx.storage.setAlarm(item.expiresAt);
    return { ok: true, value: "open" };
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
