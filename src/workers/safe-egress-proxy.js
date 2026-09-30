import http from "node:http";
import net from "node:net";

import { resolvePublicAddress } from "./public-http.js";

const ALLOWED_PORTS = new Set([80, 443]);

function proxyError(error, fallbackCode = "EGRESS_BLOCKED") {
  if (!error.code) error.code = fallbackCode;
  return error;
}

export async function validateProxyDestination(
  hostname,
  port,
  lookup,
) {
  const numericPort = Number(port);
  if (!ALLOWED_PORTS.has(numericPort)) {
    throw proxyError(
      new Error(`egress port ${numericPort} is not allowed`),
      "EGRESS_PORT_NOT_ALLOWED",
    );
  }

  const resolved = await resolvePublicAddress(hostname, lookup);
  return {
    hostname,
    port: numericPort,
    address: resolved.address,
    family: resolved.family,
  };
}

function stripProxyHeaders(headers, host) {
  const result = { ...headers, host, connection: "close" };
  delete result["proxy-authorization"];
  delete result["proxy-connection"];
  return result;
}

function destroyQuietly(socket) {
  try {
    socket.destroy();
  } catch {
    // Best effort cleanup.
  }
}

export function createSafeEgressProxy({
  lookup,
  socketTimeoutMs = 15_000,
} = {}) {
  const server = http.createServer(async (clientReq, clientRes) => {
    try {
      const target = new URL(
        clientReq.url,
        `http://${clientReq.headers.host || "invalid"}`,
      );

      if (target.protocol !== "http:") {
        clientRes.writeHead(400);
        return clientRes.end("absolute HTTP proxy requests only");
      }

      const destination = await validateProxyDestination(
        target.hostname,
        target.port || 80,
        lookup,
      );

      const upstream = http.request(
        {
          host: destination.address,
          family: destination.family,
          port: destination.port,
          method: clientReq.method,
          path: `${target.pathname}${target.search}`,
          headers: stripProxyHeaders(clientReq.headers, target.host),
          timeout: socketTimeoutMs,
        },
        (upstreamRes) => {
          clientRes.writeHead(
            upstreamRes.statusCode || 502,
            upstreamRes.statusMessage,
            upstreamRes.headers,
          );
          upstreamRes.pipe(clientRes);
        },
      );

      upstream.on("timeout", () => {
        upstream.destroy(
          proxyError(new Error("upstream request timed out"), "EGRESS_TIMEOUT"),
        );
      });
      upstream.on("error", (error) => {
        if (!clientRes.headersSent) clientRes.writeHead(502);
        clientRes.end(error.code || "EGRESS_FAILED");
      });

      clientReq.pipe(upstream);
    } catch (error) {
      clientRes.writeHead(403);
      clientRes.end(error.code || "EGRESS_BLOCKED");
    }
  });

  server.on("connect", (req, clientSocket, head) => {
    void (async () => {
      try {
        const authority = new URL(`http://${req.url}`);
        const destination = await validateProxyDestination(
          authority.hostname,
          authority.port || 443,
          lookup,
        );

        const upstream = net.connect({
          host: destination.address,
          family: destination.family,
          port: destination.port,
        });

        upstream.setTimeout(socketTimeoutMs, () => {
          destroyQuietly(upstream);
          destroyQuietly(clientSocket);
        });

        upstream.once("connect", () => {
          clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head?.length) upstream.write(head);
          upstream.pipe(clientSocket);
          clientSocket.pipe(upstream);
        });

        upstream.once("error", () => {
          if (!clientSocket.destroyed) {
            clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
          }
        });

        clientSocket.once("error", () => destroyQuietly(upstream));
      } catch (error) {
        if (!clientSocket.destroyed) {
          clientSocket.end(
            `HTTP/1.1 403 Forbidden\r\nX-Mecord-Block: ${error.code || "EGRESS_BLOCKED"}\r\n\r\n`,
          );
        }
      }
    })();
  });

  server.on("upgrade", (_req, socket) => {
    // Plain ws:// upgrades are intentionally not proxied in the first
    // public-QA worker. Secure wss:// traffic uses CONNECT and remains
    // protected by the destination validation above.
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });

  return server;
}

export async function listenSafeEgressProxy(proxy) {
  await new Promise((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", () => {
      proxy.off("error", reject);
      resolve();
    });
  });

  const address = proxy.address();
  return `http://127.0.0.1:${address.port}`;
}

export async function closeSafeEgressProxy(proxy) {
  if (!proxy?.listening) return;
  await new Promise((resolve, reject) => {
    proxy.close((error) => (error ? reject(error) : resolve()));
  });
}
