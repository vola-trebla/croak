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

# name  repo-uri  repo-id  workflow
leaf() {
  local name="$1" repo="$2" id="$3" workflow="$4"
  local ref="refs/heads/main" f="1.3.6.1.4.1.57264.1"
  cat >"$work/$name.cnf" <<EOF
[leaf]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = codeSigning
subjectAltName = critical, URI:$repo/$workflow@$ref
$f.8 = ASN1:UTF8String:https://token.actions.githubusercontent.com
$f.9 = ASN1:UTF8String:$repo/$workflow@$ref
$f.11 = ASN1:UTF8String:github-hosted
$f.12 = ASN1:UTF8String:$repo
$f.13 = ASN1:UTF8String:0000000000000000000000000000000000000000
$f.14 = ASN1:UTF8String:$ref
$f.15 = ASN1:UTF8String:$id
$f.18 = ASN1:UTF8String:$repo/$workflow@$ref
EOF
  key "$out/$name.key"
  openssl req -new -key "$out/$name.key" -subj "/" -out "$work/$name.csr"
  openssl x509 -req -in "$work/$name.csr" -CA "$out/intermediate.pem" -CAkey "$work/intermediate.key" \
    -set_serial "$id$RANDOM" -not_before 20250101000000Z -not_after 20350101000000Z \
    -extfile "$work/$name.cnf" -extensions leaf -out "$out/$name.pem" 2>/dev/null
}

wf=".github/workflows/release.yml"
leaf acme "https://github.com/acme/widget" 1001 "$wf"
leaf acme-renamed "https://github.com/acme-labs/widget" 1001 "$wf"
leaf mallory "https://github.com/mallory/widget" 6666 "$wf"

echo "test Sigstore chain written to $out"
