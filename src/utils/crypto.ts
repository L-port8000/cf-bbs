// WebCrypto API (SubtleCrypto) を用いた暗号関連ユーティリティ。
// Argon2id等のCPU負荷が高いアルゴリズムはWorkers Free PlanのCPU時間制約
// (10ms/呼び出し) と相性が悪いため使用しない。PBKDF2-SHA256を採用する。
//
// 【既知の制約】 PBKDF2の反復回数(既定10万回)はCPU負荷とFree Planの実行時間
// 制限のトレードオフになる。実測してFree Planで安定して10ms以内に収まらない
// 場合は、反復回数を減らすか、Workers Paid Planへの移行を検討すること。
// README「既知の制約」を参照。

const textEncoder = new TextEncoder();

function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

export function randomId(byteLength = 16): string {
  return randomToken(byteLength);
}

export interface PasswordHashResult {
  hash: string;
  salt: string;
  iterations: number;
}

export const DEFAULT_PBKDF2_ITERATIONS = 100_000;

export async function hashPassword(
  password: string,
  pepper: string,
  iterations = DEFAULT_PBKDF2_ITERATIONS
): Promise<PasswordHashResult> {
  const saltBytes = new Uint8Array(16);
  crypto.getRandomValues(saltBytes);
  const hash = await pbkdf2(password, pepper, saltBytes, iterations);
  return { hash: toBase64Url(hash), salt: toBase64Url(saltBytes), iterations };
}

export async function verifyPassword(
  password: string,
  pepper: string,
  storedSalt: string,
  storedIterations: number,
  storedHash: string
): Promise<boolean> {
  const saltBytes = fromBase64Url(storedSalt);
  const computed = await pbkdf2(password, pepper, saltBytes, storedIterations);
  return timingSafeEqualBytes(computed, fromBase64Url(storedHash));
}

async function pbkdf2(
  password: string,
  pepper: string,
  salt: Uint8Array,
  iterations: number
): Promise<Uint8Array> {
  // pepper (アプリ全体で共有するシークレット。DBとは別に管理する)を
  // パスワードに連結してからPBKDF2にかけることで、DB漏えい単体では
  // オフライン総当たりできないようにする。
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(`${pepper}:${password}`),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    keyMaterial,
    256
  );
  return new Uint8Array(bits);
}

export async function hmacSign(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, textEncoder.encode(data));
  return toBase64Url(sig);
}

export async function hmacVerify(secret: string, data: string, signature: string): Promise<boolean> {
  let expected: string;
  try {
    expected = await hmacSign(secret, data);
  } catch {
    return false;
  }
  return timingSafeEqualStr(expected, signature);
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ae = textEncoder.encode(a);
  const be = textEncoder.encode(b);
  return timingSafeEqualBytes(ae, be);
}

export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  // 長さが違っても早期returnせず、両方の長さの最大までダミー比較を続けて
  // タイミング差の漏えいを最小化する。
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    const av = i < a.length ? a[i]! : 0;
    const bv = i < b.length ? b[i]! : 0;
    diff |= av ^ bv;
  }
  return diff === 0;
}

export async function sha256Hex(data: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(data));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
