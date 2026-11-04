// TEST-ONLY self-signed certificate for 127.0.0.1 and "localhost" (valid until 2126) and its
// key. Not a secret: it protects nothing. Used by the fake SMTP server's STARTTLS
// (prod-mode.test.js) and the local HTTPS cover host (covers.test.js).
export const TEST_TLS = {
  key: `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgwpMB6IssEdzmIUb5
gJwwMe9UwWym0W7CtFg83lKpteWhRANCAAT+NC+iuLKnJMC1eXrKcvK49xC7lMKa
LmvihqtwHlSRS6Yo3yjXuAmgczbjZJxUsxr5oJ7nNcuk2lN/fbDyydwk
-----END PRIVATE KEY-----
`,
  cert: `-----BEGIN CERTIFICATE-----
MIIBtTCCAVugAwIBAgIUQH6UdrWznTr/S2b+hgsbTkS1/rEwCgYIKoZIzj0EAwIw
GTEXMBUGA1UEAwwOY3J3bi10ZXN0LXNtdHAwIBcNMjYxMTA0MDAzMTU2WhgPMjEy
NjEwMTEwMDMxNTZaMBkxFzAVBgNVBAMMDmNyd24tdGVzdC1zbXRwMFkwEwYHKoZI
zj0CAQYIKoZIzj0DAQcDQgAE/jQvoriypyTAtXl6ynLyuPcQu5TCmi5r4oarcB5U
kUumKN8o17gJoHM242ScVLMa+aCe5zXLpNpTf32w8sncJKN/MH0wHQYDVR0OBBYE
FDkBSij6lcO357hDrWxBPKc0xsAGMB8GA1UdIwQYMBaAFDkBSij6lcO357hDrWxB
PKc0xsAGMBoGA1UdEQQTMBGHBH8AAAGCCWxvY2FsaG9zdDAPBgNVHRMBAf8EBTAD
AQH/MA4GA1UdDwEB/wQEAwIChDAKBggqhkjOPQQDAgNIADBFAiAkGtP8EwWilu2N
desRvaJ7KwclSGyNhZ+rApGeSyHYDgIhAOowLaF08XKq/iO3OhRJ4ApJYjqnSuYj
QKtoGEiC/pZi
-----END CERTIFICATE-----
`,
};
