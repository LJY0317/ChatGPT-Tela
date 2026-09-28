import {
  createPrivateKey,
  createPublicKey,
  KeyObject,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { readPackagedProductManifest } from "./packaged-manifest";
import { PACKAGED_PAYLOAD_SIGNATURE, packagedPayloadFingerprint } from "./packaged-payload";

export interface PackagedPayloadSignatureEnvelope {
  readonly version: 1;
  readonly algorithm: "ed25519-sha256-tree-v1";
  readonly keyId: string;
  readonly productVersion: string;
  readonly payloadFingerprint: string;
  readonly signature: string;
}

export interface PackagedPayloadSigner {
  readonly keyId: string;
  sign(payloadFingerprint: string): Buffer;
}

export type PackagedPayloadTrustedKeys = Readonly<Record<string, string | Buffer | KeyObject>>;

function oneLine(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || /[\u0000\r\n]/.test(value)) throw new Error(`${field} is invalid`);
  return value.trim();
}

function fingerprint(value: unknown, field: string): string {
  const result = oneLine(value, field);
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${field} is invalid`);
  return result;
}

function parseEnvelope(value: unknown): PackagedPayloadSignatureEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("packaged payload signature envelope is invalid");
  const item = value as Record<string, unknown>;
  const extra = Object.keys(item).filter(key => !["version", "algorithm", "keyId", "productVersion", "payloadFingerprint", "signature"].includes(key));
  if (extra.length > 0) throw new Error(`packaged payload signature contains unknown fields: ${extra.join(", ")}`);
  if (item.version !== 1 || item.algorithm !== "ed25519-sha256-tree-v1") {
    throw new Error("packaged payload signature version/algorithm is unsupported");
  }
  const signature = oneLine(item.signature, "packaged payload signature bytes");
  let decoded: Buffer;
  try { decoded = Buffer.from(signature, "base64url"); }
  catch (error) { throw new Error("packaged payload signature encoding is invalid", { cause: error }); }
  if (decoded.length !== 64) throw new Error("packaged payload signature length is invalid");
  return Object.freeze({
    version: 1,
    algorithm: "ed25519-sha256-tree-v1",
    keyId: oneLine(item.keyId, "packaged payload signature key id"),
    productVersion: oneLine(item.productVersion, "packaged payload signature product version"),
    payloadFingerprint: fingerprint(item.payloadFingerprint, "packaged payload signature fingerprint"),
    signature,
  });
}

function signaturePath(payloadRoot: string): string {
  return join(payloadRoot, PACKAGED_PAYLOAD_SIGNATURE);
}

export function readPackagedPayloadSignature(payloadRoot: string): PackagedPayloadSignatureEnvelope {
  const path = signaturePath(payloadRoot);
  if (!existsSync(path)) throw new Error(`packaged payload signature is missing: ${path}`);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("packaged payload signature path is unsafe or replaced");
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")) as unknown; }
  catch (error) { throw new Error("packaged payload signature is invalid JSON", { cause: error }); }
  return parseEnvelope(value);
}

export function createEd25519PackagedPayloadSigner(input: {
  readonly keyId: string;
  readonly privateKey: string | Buffer | KeyObject;
}): PackagedPayloadSigner {
  const keyId = oneLine(input.keyId, "packaged signing key id");
  const privateKey = input.privateKey instanceof KeyObject ? input.privateKey : createPrivateKey(input.privateKey);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("packaged signing key must be Ed25519");
  return Object.freeze({
    keyId,
    sign(payloadFingerprint: string) {
      const digest = Buffer.from(fingerprint(payloadFingerprint, "packaged payload fingerprint"), "hex");
      return cryptoSign(null, digest, privateKey);
    },
  });
}

export function writePackagedPayloadSignature(input: {
  readonly payloadRoot: string;
  readonly signer: PackagedPayloadSigner;
}): PackagedPayloadSignatureEnvelope {
  const manifest = readPackagedProductManifest(input.payloadRoot);
  if (!manifest.integrity) throw new Error("packaged manifest does not declare signed payload integrity");
  if (manifest.integrity.keyId !== input.signer.keyId) throw new Error("packaged signer key id does not match the manifest");
  const payloadFingerprint = packagedPayloadFingerprint(input.payloadRoot);
  const signature = input.signer.sign(payloadFingerprint);
  if (signature.length !== 64) throw new Error("packaged signer returned an invalid Ed25519 signature");
  const envelope: PackagedPayloadSignatureEnvelope = Object.freeze({
    version: 1,
    algorithm: "ed25519-sha256-tree-v1",
    keyId: input.signer.keyId,
    productVersion: manifest.productVersion,
    payloadFingerprint,
    signature: signature.toString("base64url"),
  });
  const path = signaturePath(input.payloadRoot);
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(envelope, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try { chmodSync(temporary, 0o600); } catch { /* Windows ACLs own permissions there. */ }
  renameSync(temporary, path);
  return envelope;
}

export function verifyPackagedPayloadSignature(input: {
  readonly payloadRoot: string;
  readonly trustedKeys: PackagedPayloadTrustedKeys;
}): PackagedPayloadSignatureEnvelope {
  const manifest = readPackagedProductManifest(input.payloadRoot);
  if (!manifest.integrity) throw new Error("packaged manifest does not declare signed payload integrity");
  const envelope = readPackagedPayloadSignature(input.payloadRoot);
  if (envelope.keyId !== manifest.integrity.keyId || envelope.productVersion !== manifest.productVersion) {
    throw new Error("packaged payload signature identity does not match its manifest");
  }
  const actualFingerprint = packagedPayloadFingerprint(input.payloadRoot);
  if (envelope.payloadFingerprint !== actualFingerprint) throw new Error("packaged payload fingerprint does not match its signature envelope");
  const trusted = input.trustedKeys[envelope.keyId];
  if (!trusted) throw new Error(`packaged payload signing key is not trusted: ${envelope.keyId}`);
  const publicKey = trusted instanceof KeyObject ? trusted : createPublicKey(trusted);
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("trusted packaged payload key must be Ed25519");
  const valid = cryptoVerify(
    null,
    Buffer.from(envelope.payloadFingerprint, "hex"),
    publicKey,
    Buffer.from(envelope.signature, "base64url"),
  );
  if (!valid) throw new Error("packaged payload signature verification failed");
  return envelope;
}
