/**
 * @module tlsFixture
 * Test-only certificates, generated with `openssl` into a fresh temp directory: no private key is committed.
 * Uses only `req` and `ca` options that both OpenSSL 3 and macOS LibreSSL accept.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type KeyPair = { cert: string; key: string; certPath: string };

export type TlsFixture = {
  dir: string;
  /** Self-signed `localhost` certificate, its own trust anchor. */
  selfSigned: KeyPair;
  /** Root CA that signs `valid`, `expired`, and `mismatch`. */
  ca: KeyPair;
  /** `localhost` and `127.0.0.1`, signed by `ca`, valid now. */
  valid: KeyPair;
  /** Signed by `ca`, valid only in January 2020. */
  expired: KeyPair;
  /** Signed by `ca`, valid now, for `other.invalid` only. */
  mismatch: KeyPair;
};

const LOCALHOST_SAN = "subjectAltName=DNS:localhost,IP:127.0.0.1";

/** Generate every fixture certificate. Throws with `openssl` output when a step fails: a missing tool is a failure. */
export function createTlsFixture(): TlsFixture {
  const dir = mkdtempSync(join(tmpdir(), "broke-code-tls-"));
  const path = (name: string) => join(dir, name);

  const selfSigned = selfSign(path, "self", "/CN=localhost", LOCALHOST_SAN);
  const ca = selfSign(path, "ca", "/CN=broke-code test CA", "basicConstraints=critical,CA:TRUE");

  // [>]: `openssl ca` is the one portable way to set explicit validity dates (LibreSSL has no `-not_before`).
  writeFileSync(path("index.txt"), "");
  writeFileSync(path("serial"), "1000\n");
  writeFileSync(
    path("ca.cnf"),
    [
      "[ca]",
      "default_ca = test_ca",
      "[test_ca]",
      `dir = ${dir}`,
      "database = $dir/index.txt",
      "serial = $dir/serial",
      "new_certs_dir = $dir",
      "certificate = $dir/ca.pem",
      "private_key = $dir/ca.key",
      "default_md = sha256",
      "policy = any",
      "copy_extensions = none",
      "unique_subject = no",
      "[any]",
      "commonName = supplied",
      "[localhost]",
      LOCALHOST_SAN,
      "[other]",
      "subjectAltName=DNS:other.invalid",
      "",
    ].join("\n"),
  );
  const now = new Date();
  const inTwoDays = new Date(now.getTime() + 2 * 24 * 3600 * 1000);
  const yesterday = new Date(now.getTime() - 24 * 3600 * 1000);
  const valid = signed(path, "valid", "/CN=localhost", "localhost", asn1Time(yesterday), asn1Time(inTwoDays));
  const expired = signed(path, "expired", "/CN=localhost", "localhost", "20200101000000Z", "20200102000000Z");
  const mismatch = signed(path, "mismatch", "/CN=other.invalid", "other", asn1Time(yesterday), asn1Time(inTwoDays));
  return { dir, selfSigned, ca, valid, expired, mismatch };
}

function selfSign(path: (name: string) => string, name: string, subject: string, extension: string): KeyPair {
  openssl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    path(`${name}.key`),
    "-out",
    path(`${name}.pem`),
    "-days",
    "2",
    "-subj",
    subject,
    "-addext",
    extension,
  ]);
  return read(path, name);
}

function signed(
  path: (name: string) => string,
  name: string,
  subject: string,
  extensions: string,
  start: string,
  end: string,
): KeyPair {
  openssl([
    "req",
    "-new",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    path(`${name}.key`),
    "-out",
    path(`${name}.csr`),
    "-subj",
    subject,
  ]);
  openssl([
    "ca",
    "-batch",
    "-config",
    path("ca.cnf"),
    "-extensions",
    extensions,
    "-notext",
    "-startdate",
    start,
    "-enddate",
    end,
    "-in",
    path(`${name}.csr`),
    "-out",
    path(`${name}.pem`),
  ]);
  return read(path, name);
}

function read(path: (name: string) => string, name: string): KeyPair {
  const certPath = path(`${name}.pem`);
  return { cert: readFileSync(certPath, "utf8"), key: readFileSync(path(`${name}.key`), "utf8"), certPath };
}

// [>]: The system binary, not the first on PATH: a Homebrew build may be another architecture or version.
const OPENSSL = "/usr/bin/openssl";

function openssl(args: string[]): void {
  const result = Bun.spawnSync([OPENSSL, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0)
    throw new Error(`openssl ${args[0]} failed (${result.exitCode}): ${result.stderr.toString()}`);
}

/** `YYYYMMDDHHMMSSZ`, the date form `openssl ca -startdate` accepts everywhere. */
function asn1Time(date: Date): string {
  return `${date.toISOString().replace(/[-:T]/g, "").slice(0, 14)}Z`;
}
