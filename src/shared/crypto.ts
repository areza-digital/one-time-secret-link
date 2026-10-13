// Thin wrapper over age-encryption. All cryptography is age's; this file only picks the key type and the armor.

import * as age from "age-encryption";

/** A fresh post-quantum hybrid identity (ML-KEM-768 + X25519), `AGE-SECRET-KEY-PQ-1...`. */
export async function newIdentity(): Promise<{ identity: string; recipient: string }> {
  const identity = await age.generateHybridIdentity();
  return { identity, recipient: await age.identityToRecipient(identity) };
}

export async function encryptText(plaintext: string, recipient: string): Promise<string> {
  const encrypter = new age.Encrypter();
  encrypter.addRecipient(recipient);
  return age.armor.encode(await encrypter.encrypt(plaintext));
}

export async function decryptText(armored: string, identity: string): Promise<string> {
  const decrypter = new age.Decrypter();
  decrypter.addIdentity(identity);
  return decrypter.decrypt(age.armor.decode(armored), "text");
}

export function isIdentity(value: string): boolean {
  return /^AGE-SECRET-KEY-(?:PQ-)?1[02-9ACDEFGHJKLMNPQRSTUVWXYZ]+$/.test(value);
}
