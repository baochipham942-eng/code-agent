# LAN Noise vectors

`lan-noise-vector.json` contains **public, deterministic test keys**, never device credentials. Key pairs come from libsodium box seeds containing the bytes 1, 2, 3 and 4 repeated 32 times; the pairing PSK contains byte 5 repeated 32 times.

The IK transcript uses Neo's exact `neo-companion/lan/v1/resume` prologue and was compared byte-for-byte, including both directional transport keys, against `noise-protocol@3.0.1` (the reference dependency of `noise-handshake@4.2.0`). The reference labels split keys by the final read/write operation, so its field names must be mapped to initiator/responder directions as in its upstream comparison test.

The XXpsk0 transcript uses Neo's fixed test invitation/prologue and the upstream `noise-handshake@4.2.0` native sodium backend. Production tests compare it against the pinned pure JavaScript backend. This is a backend parity vector, not an independent implementation or a security audit.

Upstream: https://github.com/holepunchto/noise-handshake (reviewed commit `dc1f9c4398fa4335bbfdca5c4af25fdfdba86057`), https://github.com/emilbayes/noise-protocol.
