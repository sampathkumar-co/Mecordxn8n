const PROD_COOKIE = "__Host-mecord_session";
const DEV_COOKIE = "mecord_session";

function secureCookieEnabled() {
  const publicUrl = String(process.env.PUBLIC_APP_URL || "").trim();
  return /^https:\/\//i.test(publicUrl) || process.env.NODE_ENV === "production";
}

function parseCookies(header) {
  const result = new Map();
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) result.set(name, value);
  }
  return result;
}

export function platformSessionTokenFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie);
  return cookies.get(PROD_COOKIE) || cookies.get(DEV_COOKIE) || "";
}

export function setPlatformSessionCookie(res, token, expiresAt) {
  const secure = secureCookieEnabled();
  const name = secure ? PROD_COOKIE : DEV_COOKIE;
  const expiry = new Date(expiresAt);
  const maxAge = Math.max(0, Math.floor((expiry.getTime() - Date.now()) / 1000));
  const attributes = [
    `${name}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
  ];
  if (secure) attributes.push("Secure");
  res.setHeader("set-cookie", attributes.join("; "));
}

export function clearPlatformSessionCookie(res) {
  const expired = "Path=/; HttpOnly; SameSite=Strict; Max-Age=0";
  res.setHeader("set-cookie", [
    `${PROD_COOKIE}=; ${expired}; Secure`,
    `${DEV_COOKIE}=; ${expired}`,
  ]);
}
