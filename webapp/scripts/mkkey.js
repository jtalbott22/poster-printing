#!/usr/bin/env node
/**
 * npm run mkkey            -> one 32-byte hex secret
 * npm run mkkey -- --env   -> a block ready to paste into .env
 * npm run mkkey -- --api   -> an API key plus the hash to store
 *
 * Secrets are printed once and never written anywhere. If you lose one,
 * generate a new one and update both sides.
 */
const crypto = require('crypto');

const hex = () => crypto.randomBytes(32).toString('hex');
const arg = process.argv[2];

if (arg === '--env') {
  console.log(`COOKIE_SECRET=${hex()}`);
  console.log(`FLOW_SHARED_SECRET=${hex()}`);
} else if (arg === '--api') {
  // Keys are shown once and stored only as a SHA-256, the same way the
  // portal treats print-host keys. Copy the plaintext now.
  const key = 'pp_' + crypto.randomBytes(24).toString('base64url');
  console.log(`plaintext (give this to the caller): ${key}`);
  console.log(`sha256    (store this in api_keys):  ${
    crypto.createHash('sha256').update(key).digest('hex')}`);
} else {
  console.log(hex());
}
