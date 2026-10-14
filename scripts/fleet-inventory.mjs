import { pathToFileURL } from 'node:url';
const { Pool } = await import(pathToFileURL(process.argv[2]).href);
const pool = new Pool({ connectionString: process.env.SIDEWISP_DATABASE_URL, connectionTimeoutMillis: 10000 });
try {
  const s = process.env.SIDEWISP_POSTGRES_SCHEMA ?? 'sidewisp';
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw Error('INVALID_SCHEMA');
  await pool.query('SET statement_timeout = 15000');
  const table = (await pool.query('SELECT to_regclass($1) AS name', [`${s}.runtime_diagnostic_snapshots`])).rows[0].name;
  const select = table ? 'd.observed_at_ms,d.snapshot_json' : 'NULL AS observed_at_ms,NULL AS snapshot_json';
  const join = table ? `LEFT JOIN LATERAL (SELECT observed_at_ms,snapshot_json FROM "${s}".runtime_diagnostic_snapshots
    WHERE installation_id=i.id ORDER BY observed_at_ms DESC LIMIT 1) d ON true` : '';
  const rows = (await pool.query(`SELECT i.id,i.runtime,i.status,i.collector_version,i.runtime_version,i.last_seen_at_ms,
    EXISTS(SELECT 1 FROM "${s}".installation_credentials c WHERE c.installation_id=i.id
    AND c.revoked_at_ms IS NULL AND c.valid_from_ms<=extract(epoch from now())*1000
    AND (c.valid_until_ms IS NULL OR c.valid_until_ms>extract(epoch from now())*1000)) AS credential_active,
    ${select} FROM "${s}".installations i ${join} WHERE i.status!='deleted'`)).rows;
  console.log(JSON.stringify(rows.map(a => {
    const facts = a.snapshot_json?.sections?.find(s => s.key === 'updates')?.facts ?? [];
    const status = facts.find(f => f.key === 'update.attempt_state')?.value;
    const age = facts.find(f => f.key === 'update.attempt_age_seconds')?.value;
    const observedAt = a.observed_at_ms == null ? null : Number(a.observed_at_ms);
    return { id: a.id, runtime: a.runtime, status: a.status, version: a.collector_version,
      runtimeVersion: a.runtime_version, lastSeen: a.last_seen_at_ms == null ? null : Number(a.last_seen_at_ms),
      credentialActive: a.credential_active,
      diagnosticsSupported: Boolean(table),
      update: Number.isFinite(observedAt) && Number.isFinite(age) && age >= 0
        ? { status, observedAt, attemptAt: observedAt - age * 1000 } : null };
  })));
} catch { console.error('FLEET_INVENTORY_FAILED'); process.exitCode = 1; }
finally { await pool.end(); }
