import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
const derive = promisify(scrypt);
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = (await derive(password, salt, 64)) as Buffer;
  return salt + ":" + hash.toString("hex");
}
export async function verifyPassword(password: string, stored: string) {
  const [salt, hash] = stored.split(":");
  const actual = (await derive(password, salt, 64)) as Buffer;
  const expected = Buffer.from(hash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
// Sealed values are "v1.<key id>.<nonce>.<tag>.<data>"; the key id is the first 8
// hex characters of SHA-256(key). Values from before key versioning have only the
// last three parts and are tried against every known key. Retired keys stay
// readable while listed in AUTH_ENCRYPTION_KEY_PREVIOUS, until `cli re-seal` has
// rewritten everything with the current key.
const previousKeys: string[] = [];
export const keyId = (key: string) =>
  createHash("sha256").update(Buffer.from(key, "hex")).digest("hex").slice(0, 8);
export function registerPreviousKeys(keys: string[]) {
  for (const key of keys) {
    if (!/^[a-f0-9]{64}$/i.test(key))
      throw new Error("AUTH_ENCRYPTION_KEY_PREVIOUS must list 32-byte hex keys");
    if (!previousKeys.includes(key.toLowerCase())) previousKeys.push(key.toLowerCase());
  }
}
export function seal(value: unknown, key: string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), nonce);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(value)),
    cipher.final(),
  ]);
  return [
    "v1",
    keyId(key),
    ...[nonce, cipher.getAuthTag(), data].map((v) => v.toString("base64url")),
  ].join(".");
}
// True when a value is already sealed with this key (re-seal skips it).
export function sealedWith(value: string, key: string) {
  const parts = value.split(".");
  return parts.length === 5 && parts[0] === "v1" && parts[1] === keyId(key);
}
function open(parts: string[], key: string) {
  const [nonce, tag, data] = parts.map((v) => Buffer.from(v, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "hex"), nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString();
}
export function unseal<T>(value: string, key: string): T {
  const parts = value.split(".");
  const keys = [key.toLowerCase(), ...previousKeys.filter((k) => k !== key.toLowerCase())];
  if (parts.length === 5 && parts[0] === "v1") {
    const match = keys.find((k) => keyId(k) === parts[1]);
    if (!match) throw new Error("Sealed with an unknown key");
    return JSON.parse(open(parts.slice(2), match));
  }
  if (parts.length !== 3) throw new Error("Malformed sealed value");
  let failure: unknown;
  for (const candidate of keys)
    try {
      return JSON.parse(open(parts, candidate));
    } catch (error) {
      failure = error;
    }
  throw failure;
}
