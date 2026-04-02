import os from "node:os";
import { spawnSync } from "node:child_process";

function isPrivateLanIpv4(address: string): boolean {
  if (address.startsWith("10.") || address.startsWith("192.168.")) {
    return true;
  }
  const parts = address.split(".").map((value) => Number.parseInt(value, 10));
  return parts.length === 4 && parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31;
}

function rankLanAddress(address: string): number {
  if (address.startsWith("192.168.")) {
    return 0;
  }
  if (address.startsWith("10.")) {
    return 1;
  }
  const parts = address.split(".").map((value) => Number.parseInt(value, 10));
  if (parts.length === 4 && parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) {
    return 2;
  }
  return 3;
}

function parseDefaultRouteInterface(text: string): string {
  const directMatch = text.match(/(?:^|\n)\s*interface:\s*(\S+)/i);
  if (directMatch?.[1]) {
    return directMatch[1];
  }
  const devMatch = text.match(/(?:^|\n)default(?:\s+via\s+\S+)?\s+dev\s+(\S+)/i);
  if (devMatch?.[1]) {
    return devMatch[1];
  }
  return "";
}

function probeDefaultRouteInterface(): string {
  const candidates: Array<{ command: string; args: string[] }> = process.platform === "darwin"
    ? [
        { command: "route", args: ["-n", "get", "default"] },
        { command: "ip", args: ["route", "show", "default"] },
      ]
    : [
        { command: "ip", args: ["route", "show", "default"] },
        { command: "route", args: ["-n", "get", "default"] },
      ];
  for (const candidate of candidates) {
    const result = spawnSync(candidate.command, candidate.args, { encoding: "utf8" });
    if (result.status !== 0 || result.error) {
      continue;
    }
    const interfaceName = parseDefaultRouteInterface(result.stdout || "");
    if (interfaceName) {
      return interfaceName;
    }
  }
  return "";
}

function listNonInternalIpv4Addresses(): string[] {
  const addresses: string[] = [];
  const interfaces = os.networkInterfaces();
  for (const records of Object.values(interfaces)) {
    for (const record of records ?? []) {
      if (!record || record.internal || record.family !== "IPv4") {
        continue;
      }
      addresses.push(record.address);
    }
  }
  return addresses.filter((value, index, values) => values.indexOf(value) === index);
}

export function resolvePreferredLanAddress(): string | null {
  const interfaces = os.networkInterfaces();
  const defaultRouteInterface = probeDefaultRouteInterface();
  if (defaultRouteInterface) {
    const records = (interfaces[defaultRouteInterface] ?? [])
      .filter((record): record is os.NetworkInterfaceInfoIPv4 => Boolean(record) && record.family === "IPv4" && !record.internal);
    const preferredPrivate = records.find((record) => isPrivateLanIpv4(record.address));
    if (preferredPrivate) {
      return preferredPrivate.address;
    }
    if (records[0]) {
      return records[0].address;
    }
  }

  const privateCandidates = listNonInternalIpv4Addresses()
    .filter((address) => isPrivateLanIpv4(address))
    .sort((left, right) => rankLanAddress(left) - rankLanAddress(right) || left.localeCompare(right));
  if (privateCandidates[0]) {
    return privateCandidates[0];
  }

  const fallback = listNonInternalIpv4Addresses()[0];
  return fallback || null;
}
