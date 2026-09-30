import { resolveTxt } from "node:dns/promises";

export function dnsTxtMatches(records, challenge) {
  const expected = String(challenge || "").trim();
  if (!expected) return false;
  for (const record of records || []) {
    const joined = Array.isArray(record) ? record.join("") : String(record || "");
    if (joined.trim() === expected) return true;
  }
  return false;
}

export async function verifyDnsTxtOwnership({ hostname, challenge }) {
  const records = await resolveTxt(hostname);
  return dnsTxtMatches(records, challenge);
}
