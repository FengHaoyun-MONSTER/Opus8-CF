import type { Env } from "./db";

export type OperationAlertKind =
  | "user"
  | "node"
  | "landing"
  | "optimized_ip";
export type OperationAlertSeverity = "healthy" | "warning" | "danger";

export interface OperationAlert {
  kind: OperationAlertKind;
  severity: OperationAlertSeverity;
  id: string;
  title: string;
  detail: string;
}

export interface AlertIncident {
  key: string;
  kind: OperationAlertKind;
  sourceId: string;
  severity: OperationAlertSeverity;
  title: string;
  detail: string;
  status: "open" | "resolved";
  firstSeen: number;
  lastChanged: number;
  resolvedAt: number | null;
  occurrenceCount: number;
}

interface AlertIncidentRow {
  incident_key: string;
  kind: OperationAlertKind;
  source_id: string;
  severity: OperationAlertSeverity;
  title: string;
  detail: string;
  status: "open" | "resolved";
  first_seen: number;
  last_changed: number;
  resolved_at: number | null;
  occurrence_count: number;
}

function incidentKey(alert: OperationAlert): string {
  return `${alert.kind}:${alert.id}`;
}

function fromRow(row: AlertIncidentRow): AlertIncident {
  return {
    key: row.incident_key,
    kind: row.kind,
    sourceId: row.source_id,
    severity: row.severity,
    title: row.title,
    detail: row.detail,
    status: row.status,
    firstSeen: Number(row.first_seen),
    lastChanged: Number(row.last_changed),
    resolvedAt: row.resolved_at == null ? null : Number(row.resolved_at),
    occurrenceCount: Number(row.occurrence_count) || 1,
  };
}

export async function reconcileAlertIncidents(
  env: Env,
  currentAlerts: OperationAlert[],
  now: number,
): Promise<{ writes: number; incidents: AlertIncident[] }> {
  const current = new Map(
    currentAlerts.map((alert) => [incidentKey(alert), alert]),
  );
  const openResult = await env.DB.prepare(
    `SELECT incident_key,kind,source_id,severity,title,detail,status,
            first_seen,last_changed,resolved_at,occurrence_count
     FROM alert_incidents
     WHERE status='open'`,
  ).all<AlertIncidentRow>();
  const rows = new Map(
    (openResult.results ?? []).map((row) => [row.incident_key, row]),
  );
  const currentKeys = [...current.keys()];
  for (let offset = 0; offset < currentKeys.length; offset += 80) {
    const chunk = currentKeys.slice(offset, offset + 80);
    const placeholders = chunk.map((_, index) => `?${index + 1}`).join(",");
    const result = await env.DB.prepare(
      `SELECT incident_key,kind,source_id,severity,title,detail,status,
              first_seen,last_changed,resolved_at,occurrence_count
       FROM alert_incidents
       WHERE incident_key IN (${placeholders})`,
    )
      .bind(...chunk)
      .all<AlertIncidentRow>();
    for (const row of result.results ?? []) rows.set(row.incident_key, row);
  }
  const incidents = new Map(
    [...rows.values()].map((row) => {
      const incident = fromRow(row);
      return [incident.key, incident];
    }),
  );
  const statements: D1PreparedStatement[] = [];

  for (const [key, alert] of current) {
    const existing = incidents.get(key);
    if (!existing) {
      statements.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO alert_incidents
           (incident_key,kind,source_id,severity,title,detail,status,
            first_seen,last_changed,resolved_at,occurrence_count)
           VALUES (?1,?2,?3,?4,?5,?6,'open',?7,?7,NULL,1)`,
        ).bind(
          key,
          alert.kind,
          alert.id,
          alert.severity,
          alert.title,
          alert.detail,
          now,
        ),
      );
      incidents.set(key, {
        key,
        kind: alert.kind,
        sourceId: alert.id,
        severity: alert.severity,
        title: alert.title,
        detail: alert.detail,
        status: "open",
        firstSeen: now,
        lastChanged: now,
        resolvedAt: null,
        occurrenceCount: 1,
      });
      continue;
    }

    const stateChanged =
      existing.status !== "open" ||
      existing.severity !== alert.severity ||
      existing.title !== alert.title;
    if (!stateChanged) continue;
    const occurrenceCount = existing.occurrenceCount + 1;
    statements.push(
      env.DB.prepare(
        `UPDATE alert_incidents
         SET severity=?2,title=?3,detail=?4,status='open',
             last_changed=?5,resolved_at=NULL,occurrence_count=?6
         WHERE incident_key=?1`,
      ).bind(
        key,
        alert.severity,
        alert.title,
        alert.detail,
        now,
        occurrenceCount,
      ),
    );
    incidents.set(key, {
      ...existing,
      severity: alert.severity,
      title: alert.title,
      detail: alert.detail,
      status: "open",
      lastChanged: now,
      resolvedAt: null,
      occurrenceCount,
    });
  }

  for (const [key, existing] of incidents) {
    if (existing.status !== "open" || current.has(key)) continue;
    statements.push(
      env.DB.prepare(
        `UPDATE alert_incidents
         SET status='resolved',last_changed=?2,resolved_at=?2
         WHERE incident_key=?1 AND status='open'`,
      ).bind(key, now),
    );
    incidents.set(key, {
      ...existing,
      status: "resolved",
      lastChanged: now,
      resolvedAt: now,
    });
  }

  if (statements.length > 0) await env.DB.batch(statements);
  return {
    writes: statements.length,
    incidents: await listAlertIncidents(env, "all", 50),
  };
}

export async function listAlertIncidents(
  env: Env,
  status: "all" | "open" | "resolved",
  limit: number,
): Promise<AlertIncident[]> {
  const where = status === "all" ? "" : "WHERE status=?1";
  const limitIndex = status === "all" ? "?1" : "?2";
  const statement = env.DB.prepare(
    `SELECT incident_key,kind,source_id,severity,title,detail,status,
            first_seen,last_changed,resolved_at,occurrence_count
     FROM alert_incidents
     ${where}
     ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END,last_changed DESC
     LIMIT ${limitIndex}`,
  );
  const result =
    status === "all"
      ? await statement.bind(limit).all<AlertIncidentRow>()
      : await statement.bind(status, limit).all<AlertIncidentRow>();
  return (result.results ?? []).map(fromRow);
}
