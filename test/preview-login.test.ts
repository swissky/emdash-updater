import assert from "node:assert/strict";

import { LOGIN_TTL_MS, newLoginSecret, signLogin, verifyLogin } from "../src/preview-login.ts";

const secret = newLoginSecret();
const token = await signLogin(secret, "user-1", 1_000);
const login = await verifyLogin(secret, token, 1_000);
assert.equal(login?.userId, "user-1");
assert.equal(await verifyLogin(secret, token, 1_000 + LOGIN_TTL_MS), null, "Expired links are refused");
assert.equal(await verifyLogin(newLoginSecret(), token, 1_000), null, "Links signed with another secret are refused");
const [body, signature] = token.split(".");
const forged = Buffer.from(JSON.stringify({ u: "someone-else", e: 9e15, n: "x" })).toString("base64url");
assert.equal(await verifyLogin(secret, `${forged}.${signature}`, 1_000), null, "A changed user id breaks the signature");
assert.equal(await verifyLogin(secret, `${body}.${signature}.x`, 1_000), null);
assert.equal(await verifyLogin(secret, "garbage", 1_000), null);
console.log("preview login ok");
