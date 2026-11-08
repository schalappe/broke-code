/**
 * @module tls
 * Certificate side of provider requests: which CAs a provider's requests trust, and which failures are certificate
 * failures. Certificate verification itself is never turned off here or anywhere.
 */
import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import * as tls from "node:tls";
import type { ProviderError } from "./providerError";
import type { Provider } from "./providers";

/**
 * CAs for one provider's requests. `ca: undefined` -> the runtime default, which in VS Code already includes the OS
 * store (its network patch adds it only to requests that carry no `ca` of their own).
 */
export type Trust = { ok: true; ca: string[] | undefined } | { ok: false; error: ProviderError };

/**
 * Trust for `provider`. Without `caFile` -> runtime default. With it -> bundled roots + OS store + every certificate
 * of the file: Node's `ca` replaces the default store, so the file must extend it, never stand alone, or a provider
 * behind a TLS-intercepting proxy trusted by the OS would break. File read and checked on every call, so an edit
 * applies without reload; Node would ignore an invalid `ca` silently, hence the check.
 */
export async function providerTrust(provider: Provider): Promise<Trust> {
  const { name, caFile } = provider;
  if (caFile === undefined) return { ok: true, ca: undefined };
  const refused = (reason: "relative" | "unreadable" | "notPem", cause?: string): Trust => ({
    ok: false,
    error: cause === undefined ? { kind: "caFileInvalid", provider: name, path: caFile, reason } : { kind: "caFileInvalid", provider: name, path: caFile, reason, cause },
  });
  if (!isAbsolute(caFile)) return refused("relative");

  let text: string;
  try {
    text = await readFile(caFile, "utf8");
  } catch (error) {
    return refused("unreadable", error instanceof Error ? error.message : String(error));
  }
  const parsed = parseCertificates(text);
  if (!parsed.ok) return refused("notPem", parsed.cause);

  let system: string[];
  try {
    system = await systemCertificates();
  } catch (error) {
    return { ok: false, error: { kind: "systemCertificatesUnreadable", provider: name, cause: error instanceof Error ? error.message : String(error) } };
  }
  return { ok: true, ca: [...defaultCertificates(), ...system, ...parsed.certificates] };
}

const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

/** Every `CERTIFICATE` block of `text`, each one checked. Other text (comments, keys) ignored; no block -> refused. */
function parseCertificates(text: string): { ok: true; certificates: string[] } | { ok: false; cause: string } {
  const blocks = text.match(PEM_CERTIFICATE) ?? [];
  if (blocks.length === 0) return { ok: false, cause: "no -----BEGIN CERTIFICATE----- block" };
  for (const [index, block] of blocks.entries()) {
    try {
      new X509Certificate(block);
    } catch (error) {
      return { ok: false, cause: `certificate ${index + 1}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return { ok: true, certificates: blocks };
}

/** Runtime's default store when it can list it (bundled roots plus `NODE_EXTRA_CA_CERTS`), else the bundled roots. */
function defaultCertificates(): readonly string[] {
  return typeof tls.getCACertificates === "function" ? tls.getCACertificates("default") : tls.rootCertificates;
}

let systemLoad: Promise<string[]> | undefined;

/**
 * OS store, read the way VS Code reads it on the same runtime: `tls.getCACertificates("system")` where it exists
 * (Node 22.15+, VSCodium 1.143), else the macOS keychains (Node 20, VS Code 1.100). Expired certificates dropped, as
 * VS Code does, so an expired copy cannot shadow a valid one. Cached for the extension host's life, failures not.
 */
function systemCertificates(): Promise<string[]> {
  systemLoad ??= loadSystemCertificates().catch((error: unknown) => {
    systemLoad = undefined;
    throw error;
  });
  return systemLoad;
}

async function loadSystemCertificates(): Promise<string[]> {
  if (typeof tls.getCACertificates === "function") return unexpired(tls.getCACertificates("system"));
  if (process.platform === "darwin") return unexpired(await readKeychainCertificates());
  // [>]: v1 supports macOS only; Node 20 offers no OS store elsewhere without a dependency.
  return [];
}

/** Certificates of the macOS keychains, as `security find-certificate -a -p` prints them (VS Code 1.100's source). */
export function readKeychainCertificates(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/security", ["find-certificate", "-a", "-p"], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.match(PEM_CERTIFICATE) ?? []);
    });
  });
}

function unexpired(certificates: string[]): string[] {
  const now = Date.now();
  return certificates.filter((pem) => {
    try {
      return Date.parse(new X509Certificate(pem).validTo) > now;
    } catch {
      // [>]: Unparseable store entry: OpenSSL could not use it either.
      return false;
    }
  });
}

/** OpenSSL and Node codes of a server certificate the client does not trust. Anything else stays `unreachable`. */
const CERTIFICATE_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REVOKED",
  "CERT_SIGNATURE_FAILURE",
  "CERT_UNTRUSTED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "HOSTNAME_MISMATCH",
  "INVALID_CA",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

/** Errors followed along `cause`. Real chains are one or two deep (`fetch failed` -> socket error). */
const MAX_CAUSE_DEPTH = 5;

/**
 * Certificate failure code of a transport error, read on the error and along its `cause` chain
 * (`node:https` and Bun put it on the error, Node `fetch` on `error.cause`). `undefined` -> not a certificate failure.
 */
export function certificateErrorCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error && !seen.has(current); depth++) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && CERTIFICATE_CODES.has(code)) return code;
    current = current.cause;
  }
  return undefined;
}
