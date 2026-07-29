#!/usr/bin/env node
import {
  link,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { webcrypto } from "node:crypto";

const crypto = globalThis.crypto ?? webcrypto;
const MAGIC = Buffer.from("OPUS8D1\x01", "binary");
const SALT_BYTES = 16;
const IV_BYTES = 12;
const PBKDF2_ITERATIONS = 310_000;
const AAD = new TextEncoder().encode("opus8-d1-backup-v1");

function usage() {
  console.error(
    "usage: d1-backup-crypto.mjs <encrypt|decrypt> <input> <output>",
  );
  process.exit(2);
}

async function deriveKey(secret, salt) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations: PBKDF2_ITERATIONS,
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function atomicWrite(output, contents) {
  const temporary = `${output}.tmp-${process.pid}`;
  await writeFile(temporary, contents, {
    flag: "wx",
    mode: 0o600,
  });
  try {
    await link(temporary, output);
    await rm(temporary);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function encrypt(input, output, secret) {
  const plaintext = await readFile(input);
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(secret, salt);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: AAD, tagLength: 128 },
    key,
    plaintext,
  );
  const envelope = Buffer.concat([
    MAGIC,
    Buffer.from(salt),
    Buffer.from(iv),
    Buffer.from(encrypted),
  ]);
  await atomicWrite(output, envelope);
  plaintext.fill(0);
}

async function decrypt(input, output, secret) {
  const envelope = await readFile(input);
  const minimumLength = MAGIC.length + SALT_BYTES + IV_BYTES + 16;
  if (
    envelope.length < minimumLength ||
    !envelope.subarray(0, MAGIC.length).equals(MAGIC)
  ) {
    throw new Error("invalid Opus8 D1 backup envelope");
  }
  const saltStart = MAGIC.length;
  const ivStart = saltStart + SALT_BYTES;
  const cipherStart = ivStart + IV_BYTES;
  const salt = envelope.subarray(saltStart, ivStart);
  const iv = envelope.subarray(ivStart, cipherStart);
  const ciphertext = envelope.subarray(cipherStart);
  const key = await deriveKey(secret, salt);
  let plaintext;
  try {
    plaintext = Buffer.from(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: AAD, tagLength: 128 },
        key,
        ciphertext,
      ),
    );
  } catch {
    throw new Error("backup authentication failed");
  }
  await atomicWrite(output, plaintext);
  plaintext.fill(0);
}

const [operation, inputArg, outputArg] = process.argv.slice(2);
if (!["encrypt", "decrypt"].includes(operation) || !inputArg || !outputArg) {
  usage();
}
const secret = process.env.D1_BACKUP_ENCRYPTION_KEY ?? "";
if (secret.length < 32) {
  throw new Error("D1_BACKUP_ENCRYPTION_KEY must contain at least 32 characters");
}
const input = resolve(inputArg);
const output = resolve(outputArg);
if (input === output || dirname(output) === output) {
  throw new Error("input and output paths must be different files");
}
if (operation === "encrypt") {
  await encrypt(input, output, secret);
} else {
  await decrypt(input, output, secret);
}
