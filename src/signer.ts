import * as fs from 'fs';
import * as forge from 'node-forge';
import { SignedXml } from 'xml-crypto';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';
const EXC_C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#';
const SHA256 = 'http://www.w3.org/2001/04/xmlenc#sha256';
const RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';

export interface KeyMaterial {
  /** PEM-encoded private key. */
  privateKeyPem: string;
  /** Base64 DER of the X509 certificate (no PEM header/footer, no line breaks). */
  certDerBase64: string;
  /** PEM-encoded certificate (for verification). */
  certPem: string;
}

/**
 * Load cert + private key from a PKCS#12 (.p12) file.
 * Password is read from the P12_PASSWORD env var and never logged.
 */
export function loadP12(p12Path: string, password: string): KeyMaterial {
  const der = fs.readFileSync(p12Path, 'binary');
  return loadP12FromDerBinary(der, password);
}

/**
 * Load cert + private key from raw PKCS#12 DER bytes held in memory
 * (e.g. decoded from a P12_BASE64 secret). The cert is never written to disk.
 * Password is provided by the caller and never logged.
 */
export function loadP12FromDerBinary(der: string, password: string): KeyMaterial {
  const asn1 = forge.asn1.fromDer(der);
  const p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, password);

  let privateKey: forge.pki.PrivateKey | null = null;
  let certificate: forge.pki.Certificate | null = null;

  for (const safeContents of p12.safeContents) {
    for (const safeBag of safeContents.safeBags) {
      if (
        safeBag.type === forge.pki.oids.pkcs8ShroudedKeyBag ||
        safeBag.type === forge.pki.oids.keyBag
      ) {
        if (safeBag.key) privateKey = safeBag.key;
      } else if (safeBag.type === forge.pki.oids.certBag) {
        if (safeBag.cert) certificate = safeBag.cert;
      }
    }
  }

  if (!privateKey || !certificate) {
    throw new Error('P12 did not contain both a private key and a certificate');
  }
  return toKeyMaterial(privateKey as forge.pki.rsa.PrivateKey, certificate);
}

/**
 * Generate an ephemeral RSA key + self-signed certificate. Used by
 * `validate-all` when no real P12 is configured, so the full
 * generate -> sign -> validate -> verify pipeline can be exercised offline.
 */
export function generateEphemeralKey(): KeyMaterial {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 5);
  const attrs = [{ name: 'commonName', value: 'DGII Engine Ephemeral' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return toKeyMaterial(keys.privateKey, cert);
}

function toKeyMaterial(privateKey: forge.pki.rsa.PrivateKey, cert: forge.pki.Certificate): KeyMaterial {
  const privateKeyPem = forge.pki.privateKeyToPem(privateKey);
  const certPem = forge.pki.certificateToPem(cert);
  const certDer = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  const certDerBase64 = forge.util.encode64(certDer);
  return { privateKeyPem, certPem, certDerBase64 };
}

/**
 * Remove inter-element (whitespace-only) text nodes so the document serializes
 * compact, with no newlines/indentation between tags. DGII recomputes the
 * canonical form of the signed payload; any indentation whitespace inherited
 * from its seed breaks that recomputation ("Firma del certificado invalida").
 * Text inside leaf elements (e.g. <valor>, <fecha>) is left untouched.
 */
function stripInterElementWhitespace(node: any): void {
  const children = Array.from(node.childNodes || []) as any[];
  let hasElementChild = false;
  for (const c of children) {
    if (c.nodeType === 1) hasElementChild = true;
  }
  for (const c of children) {
    // TEXT_NODE (3) that is whitespace-only AND sits among element siblings.
    if (c.nodeType === 3 && hasElementChild && /^\s*$/.test(c.nodeValue || '')) {
      node.removeChild(c);
    } else if (c.nodeType === 1) {
      stripInterElementWhitespace(c);
    }
  }
}

/** Parse, drop inter-element whitespace, and re-serialize compact (single line). */
function compactXml(xml: string): string {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  stripInterElementWhitespace(doc);
  return new XMLSerializer().serializeToString(doc);
}

/**
 * Produce an enveloped XML-DSig signature (exclusive C14N, SHA-256, RSA-SHA256)
 * and append it as the last child of the document root. Output is compact,
 * UTF-8, no BOM.
 */
export function signXml(xml: string, key: KeyMaterial): string {
  // Strip the XML declaration; xml-crypto serializes the DOM without one and we
  // re-add a declaration-free compact string. (DGII accepts no-declaration XML;
  // the declaration is irrelevant to the c14n digest of the root element.)
  const declStripped = xml.replace(/^﻿?\s*<\?xml[^>]*\?>/, '');
  // Normalize away inter-element whitespace BEFORE signing so the signed payload
  // is single-line; otherwise DGII's canonical recomputation rejects the digest.
  const body = compactXml(declStripped);

  const sig = new SignedXml({
    privateKey: key.privateKeyPem,
    publicCert: key.certPem,
    signatureAlgorithm: RSA_SHA256,
    canonicalizationAlgorithm: EXC_C14N,
  });

  // Empty-URI reference => signs the whole document and avoids xml-crypto
  // injecting an `Id` attribute on the root (which the DGII XSDs reject).
  sig.addReference({
    xpath: '/*',
    transforms: [ENVELOPED, EXC_C14N],
    digestAlgorithm: SHA256,
    uri: '',
    isEmptyUri: true,
  });

  // Emit KeyInfo with the X509 certificate.
  sig.getKeyInfoContent = () =>
    `<X509Data><X509Certificate>${key.certDerBase64}</X509Certificate></X509Data>`;

  sig.computeSignature(body, {
    location: { reference: '/*', action: 'append' },
  });

  return sig.getSignedXml();
}

/**
 * Extract the 6-char security code DGII uses to bind a Factura de Consumo
 * (<250k) to its Resumen: the first 6 characters of the invoice's
 * SignatureValue. The SAME signed invoice must be used both to derive this
 * code (for the RFCE) and to upload the full XML to the portal, otherwise
 * DGII rejects with "signature value ... no coincide ... en el Resumen".
 */
export function extractSecurityCode(signedXml: string): string {
  const m = signedXml.match(
    /<(?:ds:)?SignatureValue[^>]*>([\s\S]*?)<\/(?:ds:)?SignatureValue>/
  );
  const sv = (m ? m[1] : '').replace(/\s+/g, '');
  if (sv.length < 6) throw new Error('Could not extract SignatureValue for security code');
  return sv.slice(0, 6);
}

/** Verify a signed document's signature against the embedded certificate. */
export function verifyXml(signedXml: string): boolean {
  const { DOMParser } = require('@xmldom/xmldom');
  const doc = new DOMParser().parseFromString(signedXml, 'text/xml');
  const sigNodes = doc.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature');
  if (!sigNodes || sigNodes.length === 0) return false;
  const signature = sigNodes[0];

  const sig = new SignedXml();
  sig.getCertFromKeyInfo = (keyInfo: any) => {
    const certs = keyInfo?.getElementsByTagNameNS
      ? keyInfo.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'X509Certificate')
      : null;
    if (certs && certs.length) {
      const b64 = (certs[0].textContent || '').replace(/\s+/g, '');
      // Wrap at 64 chars WITHOUT a trailing newline. The previous
      // `b64.replace(/(.{64})/g, '$1\n')` left a blank line when the cert
      // length was an exact multiple of 64 (e.g. DGII's 2048-char cert),
      // which OpenSSL 3 rejects with "asn1 wrong tag".
      const lines = b64.match(/.{1,64}/g) || [b64];
      return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----`;
    }
    return null;
  };
  sig.loadSignature(signature);
  return sig.checkSignature(signedXml);
}

/**
 * Read P12 config from env. Supports two secure injection modes:
 *   - P12_BASE64 : the .p12 encoded as base64 (preferred for managed hosts;
 *                  decoded in-memory, never touches disk).
 *   - P12_PATH   : path to a .p12 file mounted as a secret/volume.
 * Password always comes from P12_PASSWORD and is never logged.
 * Returns null when no cert is configured (ephemeral fallback for offline use).
 */
export function keyFromEnv(): KeyMaterial | null {
  const p12Base64 = process.env.P12_BASE64;
  const p12Path = process.env.P12_PATH;
  if (!p12Base64 && !p12Path) return null;
  const password = process.env.P12_PASSWORD;
  if (password === undefined) {
    throw new Error('P12 is configured but P12_PASSWORD env var is missing');
  }
  if (p12Base64) {
    // Decode to a binary string (forge expects a binary-encoded DER string).
    const der = Buffer.from(p12Base64, 'base64').toString('binary');
    return loadP12FromDerBinary(der, password);
  }
  return loadP12(p12Path as string, password);
}
