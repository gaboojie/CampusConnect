export const SESSION_COOKIE_NAME = "campusconnect_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const PASSWORD_HASH_SCHEME = "pbkdf2_sha256";
const PASSWORD_ITERATIONS = 100_000;
const PASSWORD_SALT_BYTES = 16;
const PASSWORD_KEY_BITS = 256;
const encoder = new TextEncoder();

export type PublicUser = {
  userId: number;
  username: string;
  email: string;
  phoneNumber: string | null;
  role: string;
  createdAt: string;
  creditBalance: number;
  creditLastReset: string;
  emailNotificationsOn: boolean;
  textNotificationsOn: boolean;
};

export type DatabaseUserRow = {
  user_id: number;
  username: string;
  email: string;
  phone_number: string | null;
  role: string;
  created_at: string | Date;
  credit_balance: number;
  credit_last_reset: string | Date;
  email_notifications_on: boolean;
  text_notifications_on: boolean;
  email_verified_at?: string | Date | null;
  password_hash?: string | null;
  is_banned?: boolean;
};

export type SignupInput = {
  username: string;
  email: string;
  password: string;
  confirmPassword: string;
  phoneNumber: string | null;
  emailNotificationsOn: boolean;
  textNotificationsOn: boolean;
};

export type SignupValidation =
  | { ok: true; value: SignupInput }
  | { ok: false; fieldErrors: Record<string, string> };

export type EmailVerificationTokenRow = {
  token_id: number;
  user_id: number;
  token_hash: string;
  created_at: string | Date;
  used_at: string | Date | null;
};

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);

  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function derivePasswordKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt as unknown as BufferSource,
      iterations,
      hash: "SHA-256",
    },
    key,
    PASSWORD_KEY_BITS,
  );

  return new Uint8Array(bits);
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }

  return difference === 0;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(PASSWORD_SALT_BYTES));
  const derivedKey = await derivePasswordKey(password, salt, PASSWORD_ITERATIONS);

  return [
    PASSWORD_HASH_SCHEME,
    PASSWORD_ITERATIONS,
    bytesToBase64Url(salt),
    bytesToBase64Url(derivedKey),
  ].join("$");
}

export async function verifyPassword(
  password: string,
  encodedHash: string | null | undefined,
): Promise<boolean> {
  if (!encodedHash) {
    return false;
  }

  try {
    const [scheme, iterationText, saltText, hashText] = encodedHash.split("$");
    const iterations = Number(iterationText);

    if (
      scheme !== PASSWORD_HASH_SCHEME ||
      !Number.isInteger(iterations) ||
      iterations <= 0 ||
      !saltText ||
      !hashText
    ) {
      return false;
    }

    const expectedHash = base64UrlToBytes(hashText);
    const actualHash = await derivePasswordKey(
      password,
      base64UrlToBytes(saltText),
      iterations,
    );

    return constantTimeEqual(actualHash, expectedHash);
  } catch {
    return false;
  }
}

export async function createSessionToken(): Promise<string> {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function createEmailVerificationToken(): Promise<string> {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashSessionToken(token: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(token)),
  );
  let hex = "";

  for (const byte of digest) {
    hex += byte.toString(16).padStart(2, "0");
  }

  return `\\x${hex}`;
}

export async function hashEmailVerificationToken(token: string): Promise<string> {
  return hashSessionToken(token);
}

export function isVtEmail(email: string): boolean {
  return /^[^\s@]+@vt\.edu$/i.test(email.trim());
}

export function validateSignupInput(body: unknown): SignupValidation {
  if (!body || typeof body !== "object") {
    return { ok: false, fieldErrors: { form: "Enter the requested account details." } };
  }

  const values = body as Record<string, unknown>;
  const username = typeof values.username === "string" ? values.username.trim() : "";
  const email = typeof values.email === "string" ? values.email.trim().toLowerCase() : "";
  const password = typeof values.password === "string" ? values.password : "";
  const confirmPassword =
    typeof values.confirmPassword === "string" ? values.confirmPassword : "";
  const phoneNumber =
    typeof values.phoneNumber === "string" && values.phoneNumber.trim()
      ? values.phoneNumber.trim()
      : null;
  const emailNotificationsOn =
    values.emailNotificationsOn === undefined ? true : values.emailNotificationsOn === true;
  const textNotificationsOn = values.textNotificationsOn === true && phoneNumber !== null;
  const fieldErrors: Record<string, string> = {};

  if (!/^[A-Za-z0-9_]{3,32}$/.test(username)) {
    fieldErrors.username = "Use 3–32 letters, numbers, or underscores.";
  }
  if (!isVtEmail(email)) {
    fieldErrors.email = "Use a valid Virginia Tech email ending in @vt.edu.";
  }
  if (password.length < 8 || password.length > 128) {
    fieldErrors.password = "Use a password between 8 and 128 characters.";
  }
  if (password !== confirmPassword) {
    fieldErrors.confirmPassword = "The passwords do not match.";
  }
  if (phoneNumber && phoneNumber.length > 16) {
    fieldErrors.phoneNumber = "Use a phone number with 16 or fewer characters.";
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors };
  }

  return {
    ok: true,
    value: {
      username,
      email,
      password,
      confirmPassword,
      phoneNumber,
      emailNotificationsOn,
      textNotificationsOn,
    },
  };
}

export function serializeUser(row: DatabaseUserRow): PublicUser {
  return {
    userId: row.user_id,
    username: row.username,
    email: row.email,
    phoneNumber: row.phone_number,
    role: row.role,
    createdAt: new Date(row.created_at).toISOString(),
    creditBalance: row.credit_balance,
    creditLastReset: new Date(row.credit_last_reset).toISOString().slice(0, 10),
    emailNotificationsOn: row.email_notifications_on,
    textNotificationsOn: row.text_notifications_on,
  };
}
