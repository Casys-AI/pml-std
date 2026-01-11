/**
 * Network tools - HTTP, DNS, connectivity
 *
 * @module lib/std/tools/network
 */

import { type MiniTool, runCommand } from "./common.ts";

export const networkTools: MiniTool[] = [
  {
    name: "curl_fetch",
    description:
      "Make HTTP request using curl for API calls, web scraping, and testing endpoints. Supports all HTTP methods, custom headers, request bodies, and SSL options. Use for REST API interactions, webhook testing, file downloads, or HTTP debugging. Keywords: HTTP request, API call, REST client, web fetch, curl command, HTTP GET POST.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch" },
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"],
          description: "HTTP method",
        },
        headers: { type: "object", description: "Request headers" },
        data: { type: "string", description: "Request body" },
        timeout: { type: "number", description: "Timeout in seconds (default: 30)" },
        followRedirects: { type: "boolean", description: "Follow redirects (default: true)" },
        insecure: { type: "boolean", description: "Allow insecure SSL connections" },
      },
      required: ["url"],
    },
    handler: async (
      {
        url,
        method = "GET",
        headers,
        data,
        timeout = 30,
        followRedirects = true,
        insecure = false,
      },
    ) => {
      const args = ["-s", "-w", "\n%{http_code}\n%{time_total}"];

      if (method !== "GET") args.push("-X", method as string);
      if (followRedirects) args.push("-L");
      if (insecure) args.push("-k");
      args.push("--max-time", String(timeout));

      if (headers) {
        for (const [key, value] of Object.entries(headers as Record<string, string>)) {
          args.push("-H", `${key}: ${value}`);
        }
      }

      if (data) {
        args.push("-d", data as string);
      }

      args.push(url as string);

      const result = await runCommand("curl", args, { timeout: (timeout as number) * 1000 + 5000 });

      const lines = result.stdout.trim().split("\n");
      const timeTotal = parseFloat(lines.pop() || "0");
      const statusCode = parseInt(lines.pop() || "0", 10);
      const body = lines.join("\n");

      return {
        statusCode,
        body,
        timeMs: Math.round(timeTotal * 1000),
        success: statusCode >= 200 && statusCode < 300,
      };
    },
  },
  {
    name: "dig_lookup",
    description:
      "Perform DNS lookup to resolve domain names to IP addresses. Query A, AAAA, MX, NS, TXT, CNAME, and SOA records from any DNS server. Use for DNS debugging, verifying records, checking propagation, or troubleshooting domain issues. Keywords: DNS query, domain lookup, name resolution, dig command, DNS records, MX lookup.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Domain to lookup" },
        type: {
          type: "string",
          enum: ["A", "AAAA", "MX", "NS", "TXT", "CNAME", "SOA", "ANY"],
          description: "Record type (default: A)",
        },
        server: { type: "string", description: "DNS server to use (e.g., 8.8.8.8)" },
        short: { type: "boolean", description: "Short output (answers only)" },
      },
      required: ["domain"],
    },
    handler: async ({ domain, type = "A", server, short = true }) => {
      const args = [];
      if (server) args.push(`@${server}`);
      args.push(domain as string, type as string);
      if (short) args.push("+short");

      const result = await runCommand("dig", args);
      if (result.code !== 0) {
        throw new Error(`dig failed: ${result.stderr}`);
      }

      if (short) {
        const records = result.stdout.trim().split("\n").filter(Boolean);
        return { domain, type, records, count: records.length };
      }
      return { output: result.stdout };
    },
  },
  {
    name: "ping_host",
    description:
      "Ping a host using ICMP to check network connectivity and measure latency. Returns round-trip time (RTT) statistics, packet loss percentage, and reachability status. Use for network diagnostics, uptime monitoring, troubleshooting connectivity, or testing host availability. Keywords: ping test, network connectivity, latency check, host reachable, ICMP echo, network diagnostics.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string", description: "Host to ping" },
        count: { type: "number", description: "Number of pings (default: 4)" },
        timeout: { type: "number", description: "Timeout per ping in seconds (default: 5)" },
      },
      required: ["host"],
    },
    handler: async ({ host, count = 4, timeout = 5 }) => {
      const args = ["-c", String(count), "-W", String(timeout), host as string];

      const result = await runCommand("ping", args, {
        timeout: (count as number) * (timeout as number) * 1000 + 5000,
      });

      const lines = result.stdout.split("\n");
      const statsLine = lines.find((l) => l.includes("packets transmitted"));
      const rttLine = lines.find((l) => l.includes("rtt") || l.includes("round-trip"));

      let transmitted = 0, received = 0, loss = 0;
      if (statsLine) {
        const match = statsLine.match(
          /(\d+) packets transmitted, (\d+) (?:packets )?received, (\d+(?:\.\d+)?)% packet loss/,
        );
        if (match) {
          transmitted = parseInt(match[1], 10);
          received = parseInt(match[2], 10);
          loss = parseFloat(match[3]);
        }
      }

      let min = 0, avg = 0, max = 0;
      if (rttLine) {
        const match = rttLine.match(/([\d.]+)\/([\d.]+)\/([\d.]+)/);
        if (match) {
          min = parseFloat(match[1]);
          avg = parseFloat(match[2]);
          max = parseFloat(match[3]);
        }
      }

      return {
        host,
        alive: received > 0,
        transmitted,
        received,
        lossPercent: loss,
        rtt: { min, avg, max },
      };
    },
  },
  {
    name: "nslookup",
    description:
      "Simple DNS lookup to resolve domain names to IP addresses. Easier alternative to dig for basic queries. Use for quick domain resolution, verifying DNS settings, or checking what IP a domain points to. Keywords: DNS lookup, nslookup, domain to IP, name server query, resolve hostname.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Domain to lookup" },
        server: { type: "string", description: "DNS server to use" },
      },
      required: ["domain"],
    },
    handler: async ({ domain, server }) => {
      const args = [domain as string];
      if (server) args.push(server as string);

      const result = await runCommand("nslookup", args);

      const lines = result.stdout.split("\n");
      const addresses: string[] = [];

      for (const line of lines) {
        const match = line.match(/Address:\s*([^\s]+)/);
        if (match && !line.includes("#")) {
          addresses.push(match[1]);
        }
      }

      return {
        domain,
        addresses,
        resolved: addresses.length > 0,
      };
    },
  },
  {
    name: "traceroute",
    description:
      "Trace the network path to a destination showing each hop and latency. Identifies routers between source and destination, useful for diagnosing network routing issues, finding bottlenecks, or understanding network topology. Keywords: traceroute, network path, hops, routing, network topology, packet path, latency by hop.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string", description: "Target host" },
        maxHops: { type: "number", description: "Maximum hops (default: 30)" },
      },
      required: ["host"],
    },
    handler: async ({ host, maxHops = 30 }) => {
      const args = ["-m", String(maxHops), host as string];

      const result = await runCommand("traceroute", args, { timeout: 60000 });
      return { output: result.stdout, success: result.code === 0 };
    },
  },
  {
    name: "netcat",
    description:
      "Swiss army knife for TCP/UDP networking. Check if ports are open, scan port ranges, test network services. Use for port scanning, service availability checks, firewall testing, or verifying that services are listening. Keywords: netcat, nc, port scan, port check, TCP connection, service test, open ports.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string", description: "Target host" },
        port: { type: "number", description: "Target port" },
        scan: { type: "boolean", description: "Port scan mode" },
        portRange: { type: "string", description: "Port range for scan (e.g., '20-80')" },
        timeout: { type: "number", description: "Timeout in seconds" },
      },
      required: ["host"],
    },
    handler: async ({ host, port, scan = false, portRange, timeout = 5 }) => {
      const args = ["-z", "-v", "-w", String(timeout)];
      args.push(host as string);

      if (scan && portRange) {
        args.push(portRange as string);
      } else if (port) {
        args.push(String(port));
      }

      const result = await runCommand("nc", args, { timeout: (timeout as number) * 1000 + 5000 });
      return {
        host,
        port: port || portRange,
        open: result.code === 0,
        output: result.stderr,
      };
    },
  },
  {
    name: "wget_download",
    description:
      "Download files from URLs with wget. Supports resumable downloads, recursive website mirroring, and custom output paths. Use for downloading assets, mirroring sites, fetching remote files, or automated downloads with retry capability. Keywords: wget, file download, URL fetch, mirror website, resume download, recursive download.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to download" },
        output: { type: "string", description: "Output file path" },
        recursive: { type: "boolean", description: "Recursive download" },
        depth: { type: "number", description: "Recursion depth" },
        continueDownload: { type: "boolean", description: "Continue partial download" },
      },
      required: ["url"],
    },
    handler: async ({ url, output, recursive = false, depth, continueDownload = false }) => {
      const args = ["-q"];
      if (output) args.push("-O", output as string);
      if (recursive) args.push("-r");
      if (depth) args.push("-l", String(depth));
      if (continueDownload) args.push("-c");
      args.push(url as string);

      const result = await runCommand("wget", args, { timeout: 600000 });
      if (result.code !== 0) {
        throw new Error(`wget failed: ${result.stderr}`);
      }
      return { success: true, url, output: output || "downloaded" };
    },
  },
  {
    name: "ip_address",
    description:
      "Get network interface information including IP addresses, MAC addresses, and interface status. Shows all network adapters with IPv4/IPv6 addresses and subnet masks. Use to find your IP, check network configuration, or list available interfaces. Keywords: IP address, network interface, ifconfig, ip addr, local IP, network config, MAC address.",
    category: "system",
    inputSchema: {
      type: "object",
      properties: {
        interface: { type: "string", description: "Specific interface" },
      },
    },
    handler: async ({ interface: iface }) => {
      let result = await runCommand("ip", ["-j", "addr", "show"]);

      if (result.code === 0) {
        try {
          const data = JSON.parse(result.stdout);
          const interfaces = data.map((
            i: {
              ifname: string;
              flags: string[];
              addr_info: Array<{ family: string; local: string; prefixlen: number }>;
            },
          ) => ({
            name: i.ifname,
            flags: i.flags,
            addresses:
              i.addr_info?.map((a: { family: string; local: string; prefixlen: number }) => ({
                family: a.family,
                address: a.local,
                prefixlen: a.prefixlen,
              })) || [],
          }));

          if (iface) {
            const found = interfaces.find((i: { name: string }) => i.name === iface);
            return found || { error: `Interface ${iface} not found` };
          }
          return { interfaces };
        } catch {
          return { output: result.stdout };
        }
      }

      const ifArgs = iface ? [iface as string] : [];
      result = await runCommand("ifconfig", ifArgs);
      return { output: result.stdout };
    },
  },
];
