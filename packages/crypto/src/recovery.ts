/**
 * The recovery kit: 32 random bytes shown as 24 BIP-39 words.
 *
 * Words rather than base64 because this is the one secret a human must copy by
 * hand, keep on paper, and read back correctly a year later — BIP-39 gives a
 * fixed wordlist, unambiguous prefixes, and a checksum that catches typos
 * before we ever try to decrypt.
 */
import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { KEY_BYTES } from "./primitives";

export function recoveryKeyToMnemonic(recoveryKey: Uint8Array): string {
  if (recoveryKey.length !== KEY_BYTES) {
    throw new Error(`recovery key must be ${KEY_BYTES} bytes`);
  }
  return entropyToMnemonic(recoveryKey, wordlist);
}

export function mnemonicToRecoveryKey(mnemonic: string): Uint8Array {
  const cleaned = normalizeMnemonic(mnemonic);
  if (!validateMnemonic(cleaned, wordlist)) {
    throw new Error("Those recovery words are not valid — check for typos.");
  }
  return mnemonicToEntropy(cleaned, wordlist);
}

/** Tolerate how people actually paste: stray case, punctuation, line breaks. */
export function normalizeMnemonic(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .trim()
    .split(/\s+/)
    .join(" ");
}

export function isCompleteMnemonic(input: string): boolean {
  const words = normalizeMnemonic(input).split(" ").filter(Boolean);
  return words.length === 24 && validateMnemonic(words.join(" "), wordlist);
}
