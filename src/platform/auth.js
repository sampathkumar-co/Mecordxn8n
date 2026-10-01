import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

import { pool } from "../repository.js";
import { limitsForPlan } from "./plans.js";
import {
  beginTotpEnrollment,
  confirmTotpEnrollment,
  disableTotp,
  getMfaStatus,
  verifyUserMfa,
} from "./mfa.js";

const SESSION_TTL_HOURS = 12;
const INVITE_TTL_HOURS = 72;
const SESSION_PREFIX = "mcs_";
const CSRF_PREFIX = "mcc_";
const API_KEY_PREFIX = "mck_";
const CURRENT_PASSWORD_VERSION = 2;
const DUMMY_PASSWORD_SALT =
  "000000000000000000000000000000000000000000000000";

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function randomToken(prefix, bytes = 32) {
  return `${prefix}${randomBytes(bytes).toString("base64url")}`;
}

function passwordDigest(password, salt, version = CURRENT_PASSWORD_VERSION) {
  const current = Number(version || 1) >= CURRENT_PASSWORD_VERSION;
  return scryptSync(password, salt, 64, current
    ? {
        N: 32768,
        r: 8,
        p: 3,
        maxmem: 128 * 1024 * 1024,
      }
    : {
        N: 16384,
        r: 8,
        p: 1,
        maxmem: 64 * 1024 * 1024,
      }).toString("hex");
}

async function upgradePasswordIfNeeded(client, user, password) {
  if (Number(user.password_version || 1) >= CURRENT_PASSWORD_VERSION) return;
  const salt = randomBytes(24).toString("hex");
  const digest = passwordDigest(password, salt, CURRENT_PASSWORD_VERSION);
  await client.query(
    `UPDATE platform_users
        SET password_salt = $2,
            password_hash = $3,
            password_version = $4,
            updated_at = now()
      WHERE id = $1`,
    [user.id, salt, digest, CURRENT_PASSWORD_VERSION],
  );
  user.password_salt = salt;
  user.password_hash = digest;
  user.password_version = CURRENT_PASSWORD_VERSION;
}

function safeHexEqual(actual, expected) {
  const a = Buffer.from(String(actual || ""), "hex");
  const b = Buffer.from(String(expected || ""), "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function validatePassword(password) {
  const value = String(password || "");
  if (value.length < 12 || value.length > 128) {
    const error = new Error("password must be between 12 and 128 characters");
    error.statusCode = 400;
    error.code = "PASSWORD_POLICY";
    throw error;
  }
  return value;
}

function normalizeEmail(email) {
  const value = String(email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || value.length > 320) {
    const error = new Error("email is invalid");
    error.statusCode = 400;
    error.code = "INVALID_EMAIL";
    throw error;
  }
  return value;
}

function normalizeSlug(slug) {
  const value = String(slug || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (!value || value === "system") {
    const error = new Error("workspace slug is invalid");
    error.statusCode = 400;
    error.code = "INVALID_WORKSPACE_SLUG";
    throw error;
  }
  return value;
}

function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    status: row.status,
    isPlatformOperator: Boolean(row.is_platform_operator),
  };
}

async function issueSession(
  client,
  user,
  userAgent = "",
  { mfaVerified = false } = {},
) {
  const token = randomToken(SESSION_PREFIX);
  const csrfToken = randomToken(CSRF_PREFIX, 24);
  const tokenHash = sha256(token);
  const csrfHash = sha256(csrfToken);
  const result = await client.query(
    `INSERT INTO platform_sessions (
       user_id, token_hash, csrf_hash, user_agent_hash,
       mfa_verified_at, expires_at
     )
     VALUES (
       $1,$2,$3,$4,
       CASE WHEN $5::boolean THEN now() ELSE NULL END,
       now() + ($6 * interval '1 hour')
     )
     RETURNING id, expires_at, mfa_verified_at`,
    [
      user.id,
      tokenHash,
      csrfHash,
      userAgent ? sha256(String(userAgent).slice(0, 1000)) : null,
      Boolean(mfaVerified),
      SESSION_TTL_HOURS,
    ],
  );
  return {
    token,
    csrfToken,
    sessionId: result.rows[0].id,
    expiresAt: result.rows[0].expires_at,
    mfaVerifiedAt: result.rows[0].mfa_verified_at || null,
  };
}

export async function bootstrapPlatformOwner({
  email,
  displayName,
  password,
  workspaceName,
  workspaceSlug,
  userAgent = "",
}) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedPassword = validatePassword(password);
  const slug = normalizeSlug(workspaceSlug || workspaceName);
  const name = String(workspaceName || "").trim().slice(0, 160);
  const display = String(displayName || "").trim().slice(0, 160);
  if (!name || !display) {
    const error = new Error("displayName and workspaceName are required");
    error.statusCode = 400;
    error.code = "INVALID_BOOTSTRAP";
    throw error;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(
      "SELECT COUNT(*)::int AS count FROM platform_users",
    );
    if (existing.rows[0].count !== 0) {
      const error = new Error("platform has already been bootstrapped");
      error.statusCode = 409;
      error.code = "ALREADY_BOOTSTRAPPED";
      throw error;
    }

    const salt = randomBytes(24).toString("hex");
    const userResult = await client.query(
      `INSERT INTO platform_users (
         email, display_name, password_salt, password_hash,
         password_version, is_platform_operator
       )
       VALUES ($1,$2,$3,$4,$5,true)
       RETURNING *`,
      [
        normalizedEmail,
        display,
        salt,
        passwordDigest(normalizedPassword, salt, CURRENT_PASSWORD_VERSION),
        CURRENT_PASSWORD_VERSION,
      ],
    );
    const user = userResult.rows[0];

    const workspaceResult = await client.query(
      `INSERT INTO workspaces (name, slug, plan, status)
       VALUES ($1,$2,'TEAM','ACTIVE')
       RETURNING *`,
      [name, slug],
    );
    const workspace = workspaceResult.rows[0];

    await client.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role)
       VALUES ($1,$2,'OWNER')`,
      [workspace.id, user.id],
    );
    await client.query(
      `INSERT INTO workspace_subscriptions (
         workspace_id, plan, status, seats
       )
       VALUES ($1,'TEAM','TRIALING',1)
       ON CONFLICT (workspace_id) DO NOTHING`,
      [workspace.id],
    );
    await client.query(
      `INSERT INTO workspace_security_events (
         workspace_id, user_id, event_type, severity, metadata
       )
       VALUES ($1,$2,'PLATFORM_BOOTSTRAPPED','INFO','{}'::jsonb)`,
      [workspace.id, user.id],
    );

    const session = await issueSession(client, user, userAgent);
    await client.query("COMMIT");
    return {
      user: publicUser(user),
      workspace: {
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        plan: workspace.plan,
        status: workspace.status,
      },
      ...session,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function registerSelfServeOwner({
  email,
  displayName,
  password,
  workspaceName,
  workspaceSlug,
  userAgent = "",
}) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedPassword = validatePassword(password);
  const slug = normalizeSlug(workspaceSlug || workspaceName);
  const name = String(workspaceName || "").trim().slice(0, 160);
  const display = String(displayName || "").trim().slice(0, 160);
  if (!name || !display) {
    const error = new Error("displayName and workspaceName are required");
    error.statusCode = 400;
    error.code = "INVALID_SIGNUP";
    throw error;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(
      "SELECT id FROM platform_users WHERE lower(email) = $1 FOR UPDATE",
      [normalizedEmail],
    );
    if (existing.rowCount > 0) {
      const error = new Error("account already exists");
      error.statusCode = 409;
      error.code = "ACCOUNT_EXISTS";
      throw error;
    }

    const salt = randomBytes(24).toString("hex");
    const userResult = await client.query(
      `INSERT INTO platform_users (
         email, display_name, password_salt, password_hash, password_version
       )
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [
        normalizedEmail,
        display,
        salt,
        passwordDigest(normalizedPassword, salt, CURRENT_PASSWORD_VERSION),
        CURRENT_PASSWORD_VERSION,
      ],
    );
    const user = userResult.rows[0];

    const workspaceResult = await client.query(
      `INSERT INTO workspaces (name, slug, plan, status)
       VALUES ($1,$2,'TEAM','ACTIVE')
       RETURNING *`,
      [name, slug],
    );
    const workspace = workspaceResult.rows[0];

    await client.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role)
       VALUES ($1,$2,'OWNER')`,
      [workspace.id, user.id],
    );
    await client.query(
      `INSERT INTO workspace_subscriptions (
         workspace_id, plan, status, seats, trial_ends_at
       )
       VALUES ($1,'TEAM','TRIALING',1,now() + interval '14 days')`,
      [workspace.id],
    );
    await client.query(
      `INSERT INTO workspace_onboarding (workspace_id, completed_steps)
       VALUES ($1,ARRAY['ACCOUNT_CREATED']::text[])
       ON CONFLICT (workspace_id) DO NOTHING`,
      [workspace.id],
    );
    await client.query(
      `INSERT INTO workspace_security_events (
         workspace_id, user_id, event_type, severity, metadata
       )
       VALUES (
         $1,$2,'SELF_SERVE_SIGNUP','INFO',
         jsonb_build_object('trialDays',14)
       )`,
      [workspace.id, user.id],
    );

    const session = await issueSession(client, user, userAgent);
    await client.query("COMMIT");
    return {
      user: publicUser(user),
      workspace: {
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        plan: workspace.plan,
        status: workspace.status,
      },
      trialEndsAt: new Date(Date.now() + 14 * 86400000).toISOString(),
      ...session,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function loginPlatformUser({
  email,
  password,
  mfaCode = null,
  userAgent = "",
}) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedPassword = String(password || "");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT * FROM platform_users
        WHERE lower(email) = $1
        FOR UPDATE`,
      [normalizedEmail],
    );

    if (result.rowCount === 0) {
      passwordDigest(
        normalizedPassword,
        DUMMY_PASSWORD_SALT,
        CURRENT_PASSWORD_VERSION,
      );
      await client.query("ROLLBACK");
      return null;
    }

    const user = result.rows[0];
    const digest = passwordDigest(
      normalizedPassword,
      user.password_salt,
      user.password_version || 1,
    );
    if (
      user.status !== "ACTIVE" ||
      (user.locked_until && new Date(user.locked_until).getTime() > Date.now())
    ) {
      await client.query("COMMIT");
      return null;
    }
    if (!safeHexEqual(digest, user.password_hash)) {
      const failures = Number(user.failed_login_count || 0) + 1;
      await client.query(
        `UPDATE platform_users
            SET failed_login_count = $2,
                locked_until = CASE
                  WHEN $2 >= 8 THEN now() + interval '15 minutes'
                  ELSE locked_until
                END,
                updated_at = now()
          WHERE id = $1`,
        [user.id, failures],
      );
      await client.query(
        `INSERT INTO workspace_security_events (
           user_id, event_type, severity, metadata
         )
         VALUES ($1,'LOGIN_FAILED','WARN',$2::jsonb)`,
        [user.id, JSON.stringify({ failureCount: failures })],
      );
      await client.query("COMMIT");
      return null;
    }

    await upgradePasswordIfNeeded(client, user, normalizedPassword);

    const mfa = await verifyUserMfa(client, {
      userId: user.id,
      code: mfaCode,
    });
    if (mfa.required && !mfa.verified) {
      await client.query(
        `INSERT INTO workspace_security_events (
           user_id, event_type, severity, metadata
         )
         VALUES ($1,'MFA_CHALLENGE_REQUIRED','INFO','{}'::jsonb)`,
        [user.id],
      );
      await client.query("COMMIT");
      return {
        mfaRequired: true,
        user: publicUser(user),
      };
    }

    await client.query(
      `UPDATE platform_users
          SET failed_login_count = 0,
              locked_until = NULL,
              last_login_at = now(),
              updated_at = now()
        WHERE id = $1`,
      [user.id],
    );
    const session = await issueSession(client, user, userAgent, {
      mfaVerified: Boolean(mfa.required && mfa.verified),
    });
    await client.query("COMMIT");
    return {
      user: publicUser(user),
      mfaRequired: false,
      recoveryCodeUsed: Boolean(mfa.recoveryUsed),
      ...session,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function createWorkspaceInvite({
  workspaceId,
  createdBy,
  email,
  role,
}) {
  const normalizedEmail = normalizeEmail(email);
  if (!["ADMIN", "OPERATOR", "VIEWER"].includes(role)) {
    const error = new Error("invite role is invalid");
    error.statusCode = 400;
    error.code = "INVALID_ROLE";
    throw error;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const workspace = await client.query(
      `SELECT w.id, COALESCE(s.plan, w.plan) AS plan
         FROM workspaces w
         LEFT JOIN workspace_subscriptions s ON s.workspace_id = w.id
        WHERE w.id = $1
          AND w.status = 'ACTIVE'
        FOR UPDATE OF w`,
      [workspaceId],
    );
    if (workspace.rowCount === 0) {
      const error = new Error("workspace not found");
      error.statusCode = 404;
      error.code = "WORKSPACE_NOT_FOUND";
      throw error;
    }
    const memberLimit = limitsForPlan(workspace.rows[0].plan).members;
    if (memberLimit != null) {
      const occupancy = await client.query(
        `SELECT
           (SELECT COUNT(*) FROM workspace_memberships WHERE workspace_id = $1) +
           (SELECT COUNT(*) FROM workspace_invites
             WHERE workspace_id = $1
               AND accepted_at IS NULL
               AND expires_at > now()) AS count`,
        [workspaceId],
      );
      if (Number(occupancy.rows[0].count) >= memberLimit) {
        const error = new Error("workspace member quota reached");
        error.statusCode = 409;
        error.code = "PLAN_MEMBER_LIMIT";
        throw error;
      }
    }

    const token = randomToken("mci_");
    const tokenHash = sha256(token);
    const result = await client.query(
      `INSERT INTO workspace_invites (
         workspace_id, email, role, token_hash, created_by, expires_at
       )
       VALUES ($1,$2,$3,$4,$5,now() + ($6 * interval '1 hour'))
       ON CONFLICT (workspace_id, (lower(email)))
         WHERE accepted_at IS NULL
       DO UPDATE SET
         role = EXCLUDED.role,
         token_hash = EXCLUDED.token_hash,
         created_by = EXCLUDED.created_by,
         expires_at = EXCLUDED.expires_at
       RETURNING id, workspace_id, email, role, expires_at`,
      [workspaceId, normalizedEmail, role, tokenHash, createdBy, INVITE_TTL_HOURS],
    );
    await client.query("COMMIT");
    return {
      invite: {
        id: result.rows[0].id,
        workspaceId: result.rows[0].workspace_id,
        email: result.rows[0].email,
        role: result.rows[0].role,
        expiresAt: result.rows[0].expires_at,
      },
      inviteToken: token,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function acceptWorkspaceInvite({
  token,
  password,
  displayName,
  userAgent = "",
}) {
  const rawToken = String(token || "");
  if (!rawToken.startsWith("mci_")) return null;
  const tokenHash = sha256(rawToken);
  const normalizedPassword = validatePassword(password);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inviteResult = await client.query(
      `SELECT *
         FROM workspace_invites
        WHERE token_hash = $1
          AND accepted_at IS NULL
          AND expires_at > now()
        FOR UPDATE`,
      [tokenHash],
    );
    if (inviteResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    const invite = inviteResult.rows[0];

    let userResult = await client.query(
      "SELECT * FROM platform_users WHERE lower(email) = lower($1) FOR UPDATE",
      [invite.email],
    );
    let user;
    if (userResult.rowCount === 0) {
      const display = String(displayName || "").trim().slice(0, 160);
      if (!display) {
        const error = new Error("displayName is required");
        error.statusCode = 400;
        error.code = "DISPLAY_NAME_REQUIRED";
        throw error;
      }
      const salt = randomBytes(24).toString("hex");
      userResult = await client.query(
        `INSERT INTO platform_users (
           email, display_name, password_salt, password_hash, password_version
         )
         VALUES ($1,$2,$3,$4,$5)
         RETURNING *`,
        [
          invite.email,
          display,
          salt,
          passwordDigest(normalizedPassword, salt, CURRENT_PASSWORD_VERSION),
          CURRENT_PASSWORD_VERSION,
        ],
      );
      user = userResult.rows[0];
    } else {
      user = userResult.rows[0];
      const digest = passwordDigest(
        normalizedPassword,
        user.password_salt,
        user.password_version || 1,
      );
      if (!safeHexEqual(digest, user.password_hash)) {
        await client.query("ROLLBACK");
        return null;
      }
      await upgradePasswordIfNeeded(client, user, normalizedPassword);
    }

    await client.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role)
       VALUES ($1,$2,$3)
       ON CONFLICT (workspace_id, user_id)
       DO UPDATE SET role = EXCLUDED.role`,
      [invite.workspace_id, user.id, invite.role],
    );
    await client.query(
      "UPDATE workspace_invites SET accepted_at = now() WHERE id = $1",
      [invite.id],
    );
    const session = await issueSession(client, user, userAgent);
    await client.query("COMMIT");
    return {
      user: publicUser(user),
      workspaceId: invite.workspace_id,
      role: invite.role,
      ...session,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function authenticatePlatformToken(token) {
  const raw = String(token || "");
  const tokenHash = sha256(raw);

  if (raw.startsWith(SESSION_PREFIX)) {
    const result = await pool.query(
      `SELECT s.id AS principal_id, s.user_id, s.expires_at, s.csrf_hash,
              s.mfa_verified_at,
              u.email, u.display_name, u.status, u.is_platform_operator,
              (m.enabled_at IS NOT NULL) AS mfa_enabled
         FROM platform_sessions s
         JOIN platform_users u ON u.id = s.user_id
         LEFT JOIN platform_user_mfa m ON m.user_id = u.id
        WHERE s.token_hash = $1
          AND s.revoked_at IS NULL
          AND s.expires_at > now()
          AND u.status = 'ACTIVE'`,
      [tokenHash],
    );
    if (result.rowCount === 0) return null;
    await pool.query(
      "UPDATE platform_sessions SET last_seen_at = now() WHERE id = $1",
      [result.rows[0].principal_id],
    );
    return {
      kind: "SESSION",
      id: result.rows[0].principal_id,
      userId: result.rows[0].user_id,
      user: {
        id: result.rows[0].user_id,
        email: result.rows[0].email,
        displayName: result.rows[0].display_name,
        isPlatformOperator: Boolean(result.rows[0].is_platform_operator),
      },
      csrfHash: result.rows[0].csrf_hash || null,
      mfaEnabled: Boolean(result.rows[0].mfa_enabled),
      mfaVerifiedAt: result.rows[0].mfa_verified_at || null,
      rateLimitPerHour: 4000,
    };
  }

  if (raw.startsWith(API_KEY_PREFIX)) {
    const result = await pool.query(
      `SELECT id AS principal_id, workspace_id, scopes,
              rate_limit_per_hour, expires_at
         FROM platform_api_keys
        WHERE secret_hash = $1
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > now())`,
      [tokenHash],
    );
    if (result.rowCount === 0) return null;
    await pool.query(
      "UPDATE platform_api_keys SET last_used_at = now() WHERE id = $1",
      [result.rows[0].principal_id],
    );
    return {
      kind: "API_KEY",
      id: result.rows[0].principal_id,
      workspaceId: result.rows[0].workspace_id,
      scopes: result.rows[0].scopes || [],
      rateLimitPerHour: result.rows[0].rate_limit_per_hour,
    };
  }

  return null;
}

export async function consumePlatformRateLimit(principal) {
  const result = await pool.query(
    `INSERT INTO platform_rate_buckets (
       principal_kind, principal_id, bucket_start, request_count
     )
     VALUES (
       $1,$2,date_trunc('hour', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',1
     )
     ON CONFLICT (principal_kind, principal_id, bucket_start)
     DO UPDATE SET request_count = platform_rate_buckets.request_count + 1
     RETURNING request_count`,
    [principal.kind, principal.id],
  );
  return Number(result.rows[0].request_count) <= Number(principal.rateLimitPerHour);
}

export async function getWorkspaceAccess(principal, workspaceId) {
  if (principal.kind === "API_KEY") {
    if (principal.workspaceId !== workspaceId) return null;
    const workspace = await pool.query(
      `SELECT w.status, w.plan,
              COALESCE(s.status,'ACTIVE') AS subscription_status,
              s.trial_ends_at
         FROM workspaces w
         LEFT JOIN workspace_subscriptions s ON s.workspace_id = w.id
        WHERE w.id = $1
          AND w.status = 'ACTIVE'`,
      [workspaceId],
    );
    if (workspace.rowCount === 0) return null;
    const row = workspace.rows[0];
    const subscriptionUsable =
      row.subscription_status === "ACTIVE" ||
      (
        row.subscription_status === "TRIALING" &&
        (!row.trial_ends_at || new Date(row.trial_ends_at).getTime() > Date.now())
      );
    return {
      workspaceId,
      role: "API_KEY",
      scopes: principal.scopes || [],
      plan: row.plan,
      subscriptionStatus: row.subscription_status,
      trialEndsAt: row.trial_ends_at,
      subscriptionUsable,
    };
  }

  const result = await pool.query(
    `SELECT m.workspace_id, m.role, w.status, w.plan,
            COALESCE(s.status,'ACTIVE') AS subscription_status,
            s.trial_ends_at
       FROM workspace_memberships m
       JOIN workspaces w ON w.id = m.workspace_id
       LEFT JOIN workspace_subscriptions s ON s.workspace_id = w.id
      WHERE m.workspace_id = $1
        AND m.user_id = $2
        AND w.status = 'ACTIVE'`,
    [workspaceId, principal.userId],
  );
  if (result.rowCount === 0) return null;
  const row = result.rows[0];
  const subscriptionUsable =
    row.subscription_status === "ACTIVE" ||
    (
      row.subscription_status === "TRIALING" &&
      (!row.trial_ends_at || new Date(row.trial_ends_at).getTime() > Date.now())
    );
  return {
    workspaceId,
    role: row.role,
    scopes: [],
    plan: row.plan,
    subscriptionStatus: row.subscription_status,
    trialEndsAt: row.trial_ends_at,
    subscriptionUsable,
  };
}

const ROLE_RANK = Object.freeze({
  VIEWER: 1,
  OPERATOR: 2,
  ADMIN: 3,
  OWNER: 4,
});

export function accessAllows(access, {
  minimumRole = "VIEWER",
  apiScope = "workspace:read",
} = {}) {
  if (!access) return false;
  const operationalWrite = [
    "targets:write",
    "approvals:write",
    "integrations:write",
  ].includes(apiScope);
  if (operationalWrite && access.subscriptionUsable === false) {
    return false;
  }
  if (access.role === "API_KEY") {
    return access.scopes.includes("*") || access.scopes.includes(apiScope);
  }
  return (ROLE_RANK[access.role] || 0) >= (ROLE_RANK[minimumRole] || 0);
}

export async function listWorkspaceInvites(workspaceId) {
  const result = await pool.query(
    `SELECT id, workspace_id, email, role, created_by,
            expires_at, accepted_at, created_at
       FROM workspace_invites
      WHERE workspace_id = $1
      ORDER BY created_at DESC
      LIMIT 200`,
    [workspaceId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    email: row.email,
    role: row.role,
    createdBy: row.created_by,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    createdAt: row.created_at,
    status: row.accepted_at
      ? "ACCEPTED"
      : new Date(row.expires_at).getTime() <= Date.now()
        ? "EXPIRED"
        : "PENDING",
  }));
}

export async function listPlatformUserSessions(userId) {
  const result = await pool.query(
    `SELECT id, user_agent_hash, expires_at, revoked_at,
            last_seen_at, created_at
       FROM platform_sessions
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 100`,
    [userId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    userAgentFingerprint: row.user_agent_hash
      ? row.user_agent_hash.slice(0, 12)
      : null,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    status: row.revoked_at
      ? "REVOKED"
      : new Date(row.expires_at).getTime() <= Date.now()
        ? "EXPIRED"
        : "ACTIVE",
  }));
}

export async function revokePlatformUserSession(userId, sessionId) {
  const result = await pool.query(
    `UPDATE platform_sessions
        SET revoked_at = COALESCE(revoked_at, now())
      WHERE id = $1
        AND user_id = $2
      RETURNING id`,
    [sessionId, userId],
  );
  return result.rowCount > 0;
}

export async function revokePlatformSession(sessionId) {
  await pool.query(
    "UPDATE platform_sessions SET revoked_at = now() WHERE id = $1",
    [sessionId],
  );
}

export async function getPlatformMfaStatus(userId) {
  return await getMfaStatus(pool, userId);
}

export async function beginPlatformMfaEnrollment({ userId, email }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await beginTotpEnrollment(client, { userId, email });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function confirmPlatformMfaEnrollment({
  userId,
  sessionId,
  code,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const enabled = await confirmTotpEnrollment(client, { userId, code });
    if (!enabled) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(
      `UPDATE platform_sessions
          SET revoked_at = CASE WHEN id = $2 THEN revoked_at ELSE now() END,
              mfa_verified_at = CASE WHEN id = $2 THEN now() ELSE mfa_verified_at END
        WHERE user_id = $1
          AND revoked_at IS NULL`,
      [userId, sessionId],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function verifyPlatformMfaStepUp({
  userId,
  sessionId,
  code,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await verifyUserMfa(client, { userId, code });
    if (!result.required || !result.verified) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(
      `UPDATE platform_sessions
          SET mfa_verified_at = now()
        WHERE id = $1
          AND user_id = $2
          AND revoked_at IS NULL`,
      [sessionId, userId],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function disablePlatformMfa({
  userId,
  sessionId,
  code,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await verifyUserMfa(client, { userId, code });
    if (!result.required || !result.verified) {
      await client.query("ROLLBACK");
      return false;
    }
    await disableTotp(client, userId);
    await client.query(
      `UPDATE platform_sessions
          SET revoked_at = CASE WHEN id = $2 THEN revoked_at ELSE now() END
        WHERE user_id = $1
          AND revoked_at IS NULL`,
      [userId, sessionId],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function verifyPlatformCsrf(principal, token) {
  if (principal?.kind !== "SESSION" || !principal.csrfHash) return false;
  return safeHexEqual(sha256(String(token || "")), principal.csrfHash);
}

export function hashPlatformToken(token) {
  return sha256(token);
}

export function createPlatformApiKeySecret() {
  const token = randomToken(API_KEY_PREFIX);
  return {
    token,
    prefix: token.slice(0, 12),
    secretHash: sha256(token),
  };
}
