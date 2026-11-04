import net from "node:net";

// Which IP addresses the server may connect to when it fetches an admin-typed
// URL (series covers, docs/API.md v1.5): public unicast only. Parsing is
// Node's (net.isIP / net.BlockList), which accepts every IPv6 spelling.

const IPV4_NOT_PUBLIC = new net.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (cloud metadata: 169.254.169.254)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast (deprecated)
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and 255.255.255.255
]) {
  IPV4_NOT_PUBLIC.addSubnet(network, prefix, "ipv4");
}

// IPv6: only global unicast (2000::/3) can be public. Everything else is out by
// construction: ::, ::1, IPv4-mapped ::ffff:0:0/96 and IPv4-compatible ::/96,
// NAT64 64:ff9b::/96, discard 100::/64, unique-local fc00::/7, link-local
// fe80::/10, site-local fec0::/10, multicast ff00::/8.
const IPV6_GLOBAL = new net.BlockList();
IPV6_GLOBAL.addSubnet("2000::", 3, "ipv6");
const IPV6_NOT_PUBLIC = new net.BlockList();
for (const [network, prefix] of [
  ["2001::", 23], // IETF protocol assignments (Teredo, benchmarking, ORCHID, ...)
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4: embeds an IPv4 address that may be private
  ["3fff::", 20], // documentation
]) {
  IPV6_NOT_PUBLIC.addSubnet(network, prefix, "ipv6");
}

/** True only for a public unicast IPv4 or IPv6 address (a literal, not a host name). */
export function isPublicAddress(ip) {
  if (typeof ip !== "string" || ip.includes("%")) return false; // a zone id means link-local
  switch (net.isIP(ip)) {
    case 4:
      return !IPV4_NOT_PUBLIC.check(ip, "ipv4");
    case 6:
      return IPV6_GLOBAL.check(ip, "ipv6") && !IPV6_NOT_PUBLIC.check(ip, "ipv6");
    default:
      return false;
  }
}
