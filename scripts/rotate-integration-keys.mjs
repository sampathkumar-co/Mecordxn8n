import { pool } from "../src/repository.js";
import {
  activeIntegrationKeyVersion,
  decryptIntegrationConfig,
  encryptIntegrationConfig,
} from "../src/integrations/crypto.js";

const activeVersion = activeIntegrationKeyVersion();
const client = await pool.connect();
let rotated = 0;
let skipped = 0;

try {
  await client.query("BEGIN");
  const result = await client.query(
    `SELECT id, workspace_id, provider,
            config_ciphertext, config_iv, config_tag, config_version
       FROM integration_connections
      ORDER BY id
      FOR UPDATE`,
  );

  for (const row of result.rows) {
    const currentVersion = Number(row.config_version || 1);
    if (currentVersion === activeVersion) {
      skipped += 1;
      continue;
    }

    const config = decryptIntegrationConfig({
      ciphertext: row.config_ciphertext,
      iv: row.config_iv,
      tag: row.config_tag,
      version: currentVersion,
      workspaceId: row.workspace_id,
      provider: row.provider,
    });
    const encrypted = encryptIntegrationConfig({
      config,
      workspaceId: row.workspace_id,
      provider: row.provider,
      version: activeVersion,
    });
    await client.query(
      `UPDATE integration_connections
          SET config_ciphertext = $2,
              config_iv = $3,
              config_tag = $4,
              config_version = $5,
              updated_at = now()
        WHERE id = $1`,
      [
        row.id,
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.tag,
        encrypted.version,
      ],
    );
    rotated += 1;
  }

  await client.query("COMMIT");
  console.log(JSON.stringify({
    ok: true,
    activeVersion,
    rotated,
    skipped,
  }));
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
