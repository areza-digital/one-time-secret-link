// Rate-limit key for a client address.

/** IPv4 as is; IPv6 cut to its /64, since one client usually controls a whole /64. */
export function ipBucket(ip: string): string {
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = ip.includes("::") && tail ? tail.split(":") : [];
  const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return `${groups.slice(0, 4).map((group) => group.padStart(4, "0")).join(":")}::/64`;
}
