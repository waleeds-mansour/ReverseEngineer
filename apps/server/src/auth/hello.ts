// The Windows Hello key Hearth's window on this PC signs in with (D80). The desktop app makes it
// with Windows Hello when you connect this PC, and sends its public half with the one-time ticket
// connecting gave it. To sign the window in again, the app asks Windows Hello to sign a fresh
// challenge with it: Windows asks for your face, finger or PIN each time, and the private half
// never leaves this PC. A device's token alone still never becomes a session (D53).
import { constants, createPublicKey, type KeyObject, verify } from "node:crypto";
import { type DbOrTx, setting } from "@hearth/db";
import { eq } from "drizzle-orm";

const HELLO_KEY = "desktop.hello_key";

/**
 * A public key as Windows Hello gives it: X.509 SubjectPublicKeyInfo, in base64. Only RSA of 2048
 * bits or more, which is what Windows Hello makes.
 */
export function readHelloKey(spki: string): KeyObject | null {
  if (spki.length > 2048 || !/^[A-Za-z0-9+/]+={0,2}$/.test(spki)) return null;
  try {
    const key = createPublicKey({ key: Buffer.from(spki, "base64"), format: "der", type: "spki" });
    const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
    return key.asymmetricKeyType === "rsa" && bits >= 2048 ? key : null;
  } catch {
    return null;
  }
}

export async function saveHelloKey(db: DbOrTx, spki: string, now = new Date()): Promise<void> {
  const value = { spki, addedAt: now.toISOString() };
  await db
    .insert(setting)
    .values({ key: HELLO_KEY, value, updatedAt: now })
    .onConflictDoUpdate({ target: setting.key, set: { value, updatedAt: now } });
}

/** The window's key, while the app is connected: pairing again or disconnecting forgets it. */
export async function helloKey(db: DbOrTx): Promise<string | null> {
  const [row] = await db.select().from(setting).where(eq(setting.key, HELLO_KEY));
  const spki = (row?.value as { spki?: unknown } | undefined)?.spki;
  return typeof spki === "string" ? spki : null;
}

export async function forgetHelloKey(db: DbOrTx): Promise<void> {
  await db.delete(setting).where(eq(setting.key, HELLO_KEY));
}

/**
 * Whether the window's key signed this challenge. Windows Hello signs with SHA-256 and PKCS #1
 * v1.5 padding (KeyCredential.RequestSignAsync); PSS is taken too, should a Windows sign that way.
 * The app signs the challenge's own characters.
 */
export function signedByHello(spki: string, challenge: string, signature: string): boolean {
  const key = readHelloKey(spki);
  if (!key || signature.length > 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) return false;
  const data = Buffer.from(challenge);
  const sig = Buffer.from(signature, "base64");
  const pss = {
    key,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: constants.RSA_PSS_SALTLEN_AUTO,
  };
  try {
    return verify("sha256", data, key, sig) || verify("sha256", data, pss, sig);
  } catch {
    return false;
  }
}
