// Wire format shared by the Worker, the browser pages and the CLI.

export const LIMITS = {
  plaintextChars: 10_000,
  ciphertextBytes: 48 * 1024,
  labelChars: 140,
  recipientChars: 4_096,
  minTtlSeconds: 60 * 60,
  maxTtlSeconds: 7 * 24 * 60 * 60,
} as const;

export const TTL_CHOICES = [
  { seconds: 60 * 60, key: "1h" },
  { seconds: 24 * 60 * 60, key: "24h" },
  { seconds: 3 * 24 * 60 * 60, key: "3d" },
  { seconds: 7 * 24 * 60 * 60, key: "7d" },
] as const;

export type ItemKind = "send" | "request";
export type ItemState = "open" | "filled" | "read" | "revoked" | "removed";

/** What GET /api/items/:id returns. Never contains ciphertext or token hashes. */
export interface PublicItem {
  id: string;
  kind: ItemKind;
  state: ItemState;
  verified: boolean;
  verifiedName: string | null;
  label: string | null;
  recipient: string | null;
  createdAt: number;
  expiresAt: number;
  filledAt: number | null;
  readAt: number | null;
}

export interface CreateSendBody {
  kind: "send";
  ciphertext: string;
  ttl: number;
  auth: string;
}

export interface CreateRequestBody {
  kind: "request";
  recipient: string;
  label: string;
  ttl: number;
  auth: string;
}

export type CreateBody = CreateSendBody | CreateRequestBody;

export const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
export const AUTH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const ARMOR_BEGIN = "-----BEGIN AGE ENCRYPTED FILE-----";
export const ARMOR_END = "-----END AGE ENCRYPTED FILE-----";

export function isArmoredAge(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.startsWith(ARMOR_BEGIN) && trimmed.endsWith(ARMOR_END);
}

/** Only post-quantum hybrid recipients (age1pq1…): a classic X25519 key would quietly weaken a request. */
export function isRecipient(value: unknown): value is string {
  return typeof value === "string" && value.length <= LIMITS.recipientChars && /^age1pq1[02-9ac-hj-np-z]+$/.test(value);
}

export function isTtl(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= LIMITS.minTtlSeconds &&
    value <= LIMITS.maxTtlSeconds
  );
}

/** Byte length of a string as UTF-8. */
export function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Invisible characters a phisher could hide in a label: every format/control/private-use/surrogate code point,
 * variation selectors (incl. the supplementary ones), the combining grapheme joiner and Hangul fillers.
 */
const INVISIBLE = /[\p{Cf}\p{Cc}\p{Co}\p{Cs}\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180f\u3164\ufe00-\ufe0f\uffa0\u{e0100}-\u{e01ef}]/gu;

export function cleanLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value
    .replace(/[\t\n\r\v\f]/g, " ")
    .replace(INVISIBLE, "")
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim();
  if (!label || [...label].length > LIMITS.labelChars) return null;
  return label;
}

/**
 * Default words anonymous labels may not contain. Plain entries match anywhere ("patvirtin" catches "patvirtinta");
 * entries starting with "=" match whole words only ("=pin" blocks "PIN" but not "pinigai").
 */
export const DEFAULT_RESERVED_WORDS = [
  "verif",
  "patvirtin",
  "official",
  "oficial",
  "=pin",
  "=pin1",
  "=pin2",
  "=puk",
  "=smart-id",
  "=smartid",
  "=mobile-id",
  "=swedbank",
  "=seb",
  "=luminor",
  "=citadele",
  "=revolut",
  "=paysera",
  "=siauliu",
];

/** Cyrillic and Greek letters that look like Latin ones, folded before the reserved-word check. */
const LOOKALIKES: Record<string, string> = {
  а: "a", в: "b", е: "e", ё: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x", ѕ: "s",
  і: "i", ї: "i", ј: "j", ԁ: "d", ԛ: "q", ԝ: "w", ӏ: "l", ү: "y", һ: "h", ɡ: "g",
  α: "a", β: "b", ε: "e", η: "n", ι: "i", κ: "k", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x", ω: "w", ζ: "z",
};

/** Lower-case, accent-free, lookalike-folded form used for every label comparison. */
function fold(value: string): string {
  return [...value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()].map((char) => LOOKALIKES[char] ?? char).join("");
}

/** Case-, accent- and lookalike-insensitive: "PATVIRTINTA", "patvirtintą" and "pаtvirtinta" (Cyrillic а) all match. */
export function isReservedLabel(label: string, words: readonly string[] = DEFAULT_RESERVED_WORDS): boolean {
  const text = fold(label);
  const tokens = new Set(text.split(/[^\p{L}\p{N}-]+/u).filter(Boolean));
  return words.some((entry) => {
    const whole = entry.startsWith("=");
    const word = fold(whole ? entry.slice(1) : entry);
    return word ? (whole ? tokens.has(word) : text.includes(word)) : false;
  });
}

/** Parses the RESERVED_LABEL_WORDS var ("a,=b,c"); empty or missing means the defaults. */
export function reservedWords(value: string | undefined): string[] {
  const words = (value ?? "").split(",").map((word) => word.trim()).filter(Boolean);
  return words.length ? words : DEFAULT_RESERVED_WORDS;
}

const OTHER_SCRIPTS = /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}\p{Script=Cherokee}]/u;
const LABEL_CHARS = /^[\p{L}\p{M}\p{N} .,:;!?'"„“”‘’()[\]\-–—/&+@#%*_]+$/u;

/**
 * Why an anonymous label is refused, or null if it is fine. Verified (operator) labels skip this.
 * "reserved": impersonation or phishing words; "suspicious": symbols like ✓ or emoji, or a word mixing Latin with
 * lookalike alphabets ("Arеza" with a Cyrillic е).
 */
export function labelProblem(label: string, words: readonly string[] = DEFAULT_RESERVED_WORDS): "reserved" | "suspicious" | null {
  if (!LABEL_CHARS.test(label)) return "suspicious";
  for (const word of label.split(/[^\p{L}]+/u)) {
    if (/\p{Script=Latin}/u.test(word) && OTHER_SCRIPTS.test(word)) return "suspicious";
  }
  return isReservedLabel(label, words) ? "reserved" : null;
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(byteLength = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function sha256(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

export async function sha256Hex(value: string): Promise<string> {
  return [...(await sha256(value))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The token that proves someone holds an item's identity. The server stores only sha256Hex(token). */
export async function authFromIdentity(identity: string): Promise<string> {
  return base64url(await sha256(`vienkartine/v1/auth\n${identity}`));
}

export type Lang = "lt" | "en";

export function linkFor(base: string, lang: Lang, kind: "s" | "r" | "o", id: string, fragment?: string): string {
  const prefix = lang === "en" ? "/en" : "";
  return `${base.replace(/\/$/, "")}${prefix}/${kind}/${id}${fragment ? `#${fragment}` : ""}`;
}
