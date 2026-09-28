import { createHash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect } from "node:tls";

const HOST = "web.modulbank.ru";

// Verify the server with the OS CA bundle first. Chromium's isolated root store omits
// the Russian CA; pin only this verified leaf SPKI for the lifetime of one browser.
// No ignoreHTTPSErrors or global --ignore-certificate-errors flag is used.
export function verifiedOwaSpki(): Promise<string> {
  const ca = readFileSync("/etc/ssl/certs/ca-certificates.crt");
  return new Promise((resolve, reject) => {
    const socket = connect({ host: HOST, port: 443, servername: HOST, ca, rejectUnauthorized: true, timeout: 10_000 });
    socket.once("secureConnect", () => {
      try {
        if (!socket.authorized) throw new Error("tls_untrusted");
        const raw = socket.getPeerCertificate().raw;
        if (!raw) throw new Error("tls_missing_certificate");
        const cert = new X509Certificate(raw);
        const spki = cert.publicKey.export({ type: "spki", format: "der" });
        resolve(createHash("sha256").update(spki).digest("base64"));
      } catch (error) { reject(error); }
      finally { socket.end(); }
    });
    socket.once("timeout", () => socket.destroy(new Error("tls_timeout")));
    socket.once("error", reject);
  });
}
