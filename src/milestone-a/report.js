function esc(value) {
  return String(value ?? "").replace(/\r?\n/g, " ").trim();
}

export function buildClientProposal({ target, findings }) {
  const verified = findings.filter((item) => item.verification?.status === "VERIFIED");
  const highValue = [...verified].sort(
    (a, b) => Number(b.intelligence?.opportunityScore || 0) -
      Number(a.intelligence?.opportunityScore || 0),
  );

  const lines = [
    `# Website Reliability & Remediation Proposal — ${esc(target.organizationName)}`,
    "",
    "## Executive summary",
    "",
    `We identified ${verified.length} independently reproduced website-quality issue(s) on the authorized target. The findings below are based on observed technical evidence; any business-impact scoring is directional and does not assume access to private analytics, revenue, or conversion data.`,
    "",
    "## Verified findings",
    "",
  ];

  if (highValue.length === 0) {
    lines.push("No independently verified findings are currently ready for proposal.");
  }

  highValue.forEach((item, index) => {
    lines.push(
      `### ${index + 1}. ${esc(item.title)}`,
      "",
      `- **Affected URL:** ${esc(item.affectedUrl)}`,
      `- **Severity:** ${esc(item.severity)}`,
      `- **Reproduction confidence:** ${Math.round(Number(item.verification.confidence || 0) * 100)}%`,
      `- **Impact tier:** ${esc(item.intelligence?.impactTier || "LOW")}`,
      `- **Opportunity score:** ${esc(item.intelligence?.opportunityScore ?? 0)}/100`,
      `- **Observed evidence:** ${esc(JSON.stringify(item.verification.evidence || {})).slice(0, 1200)}`,
      `- **Assessment:** ${esc(item.intelligence?.rationale || "")}`,
      "",
    );
  });

  lines.push(
    "## Proposed engagement",
    "",
    "1. Confirm the affected flows and desired behavior with the organisation.",
    "2. Reproduce the verified issue in an authorized development or staging environment.",
    "3. Diagnose the root cause and implement the smallest safe remediation.",
    "4. Run project quality gates and the original browser verification again.",
    "5. Deliver before/after evidence and a concise change summary.",
    "",
    "## Scope & safety",
    "",
    "This proposal is generated only from the target and capabilities recorded in the authorization registry. Source-code remediation is performed only for explicitly client-authorized projects.",
  );

  return lines.join("\n");
}
