#!/usr/bin/env bash
# Generates the TEST-ONLY Sigstore chain the eval's fake registry signs
# provenance with (M7): a root and an intermediate CA in Fulcio's shape, and
# one signing certificate per build identity, with Fulcio's extensions.
# Nothing outside croak's tests trusts these keys. Run once; the output is
# committed to src/crypto/fixtures/test-sigstore/.
set -euo pipefail

out="$(cd "$(dirname "$0")/.." && pwd)/src/crypto/fixtures/test-sigstore"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$out"

key() { openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$1" 2>/dev/null; }

cat >"$work/ca.cnf" <<'EOF'
[root]
basicConstraints = critical, CA:true
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
[intermediate]
basicConstraints = critical, CA:true, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
extendedKeyUsage = codeSigning
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
EOF

key "$work/root.key"
openssl req -new -key "$work/root.key" -subj "/O=croak-test/CN=croak-test-fulcio-root" -out "$work/root.csr"
openssl x509 -req -in "$work/root.csr" -signkey "$work/root.key" \
  -set_serial 1 -not_before 20250101000000Z -not_after 20350101000000Z \
  -extfile "$work/ca.cnf" -extensions root -out "$out/root.pem" 2>/dev/null

key "$work/intermediate.key"
openssl req -new -key "$work/intermediate.key" -subj "/O=croak-test/CN=croak-test-fulcio-intermediate" \
  -out "$work/intermediate.csr"
openssl x509 -req -in "$work/intermediate.csr" -CA "$out/root.pem" -CAkey "$work/root.key" \
  -set_serial 2 -not_before 20250101000000Z -not_after 20350101000000Z \
  -extfile "$work/ca.cnf" -extensions intermediate -out "$out/intermediate.pem" 2>/dev/null

# name  repo-uri  repo-id  workflow  [key-type ca eku not-before]
leaf() {
  local name="$1" repo="$2" id="$3" workflow="$4"
  local type="${5:-ec}" ca="${6:-false}" eku="${7:-codeSigning}" from="${8:-20250101000000Z}"
  local ref="refs/heads/main" f="1.3.6.1.4.1.57264.1"
  {
    echo "[leaf]"
    echo "basicConstraints = critical, CA:$ca"
    echo "keyUsage = critical, digitalSignature"
    echo "extendedKeyUsage = $eku"
    echo "subjectAltName = critical, URI:$repo/$workflow@$ref"
    echo "$f.8 = ASN1:UTF8String:https://token.actions.githubusercontent.com"
    echo "$f.9 = ASN1:UTF8String:$repo/$workflow@$ref"
    echo "$f.11 = ASN1:UTF8String:github-hosted"
    echo "$f.12 = ASN1:UTF8String:$repo"
    echo "$f.13 = ASN1:UTF8String:0000000000000000000000000000000000000000"
    echo "$f.14 = ASN1:UTF8String:$ref"
    echo "$f.15 = ASN1:UTF8String:$id"
    echo "$f.18 = ASN1:UTF8String:$repo/$workflow@$ref"
  } >"$work/$name.cnf"
  if [ "$type" = ed25519 ]; then
    openssl genpkey -algorithm ED25519 -out "$out/$name.key" 2>/dev/null
  else
    key "$out/$name.key"
  fi
  openssl req -new -key "$out/$name.key" -subj "/" -out "$work/$name.csr"
  openssl x509 -req -in "$work/$name.csr" -CA "$out/intermediate.pem" -CAkey "$work/intermediate.key" \
    -set_serial "$id$RANDOM" -not_before "$from" -not_after 20350101000000Z \
    -extfile "$work/$name.cnf" -extensions leaf -out "$out/$name.pem" 2>/dev/null
}

wf=".github/workflows/release.yml"
acme="https://github.com/acme/widget"
leaf acme "$acme" 1001 "$wf"
leaf acme-renamed "https://github.com/acme-labs/widget" 1001 "$wf"
leaf mallory "https://github.com/mallory/widget" 6666 "$wf"
# Certificates the verifier must refuse, one flaw each.
leaf acme-ed25519 "$acme" 1001 "$wf" ed25519
leaf acme-ca "$acme" 1001 "$wf" ec true
leaf acme-no-codesign "$acme" 1001 "$wf" ec false emailProtection
leaf acme-late "$acme" 1001 "$wf" ec false codeSigning 20260601000000Z

echo "test Sigstore chain written to $out"
