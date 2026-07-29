import type { Env } from "./db";
import {
  openJsonWithRotation,
  sealJson,
} from "./secret-box";
import { previousSecretConfigured } from "./key-rotation";

interface LandingCredentialRow {
  id: string;
  credential_enc: string;
}

interface LandingCredential {
  username: string;
  password: string;
}

export interface LandingCredentialRotationStatus {
  previousKeyConfigured: boolean;
  total: number;
  current: number;
  previous: number;
  unreadable: number;
}

function validCredential(value: unknown): value is LandingCredential {
  if (!value || typeof value !== "object") return false;
  const credential = value as Partial<LandingCredential>;
  return (
    typeof credential.username === "string" &&
    credential.username.length > 0 &&
    typeof credential.password === "string" &&
    credential.password.length > 0
  );
}

async function rows(env: Env): Promise<LandingCredentialRow[]> {
  const result = await env.DB.prepare(
    "SELECT id, credential_enc FROM landings ORDER BY id ASC",
  ).all<LandingCredentialRow>();
  return result.results ?? [];
}

async function inspectRow(
  env: Env,
  row: LandingCredentialRow,
): Promise<{
  row: LandingCredentialRow;
  credential: LandingCredential | null;
  secretSlot: "current" | "previous" | "unreadable";
}> {
  try {
    const opened = await openJsonWithRotation<LandingCredential>(
      env.LANDING_CONFIG_KEY,
      env.LANDING_CONFIG_KEY_PREVIOUS,
      row.credential_enc,
      `landing:${row.id}`,
    );
    if (!validCredential(opened.value)) {
      return { row, credential: null, secretSlot: "unreadable" };
    }
    return {
      row,
      credential: opened.value,
      secretSlot: opened.secretSlot,
    };
  } catch {
    return { row, credential: null, secretSlot: "unreadable" };
  }
}

export async function landingCredentialRotationStatus(
  env: Env,
): Promise<LandingCredentialRotationStatus> {
  const inspected = await Promise.all((await rows(env)).map((row) =>
    inspectRow(env, row)
  ));
  return {
    previousKeyConfigured: previousSecretConfigured(
      env.LANDING_CONFIG_KEY,
      env.LANDING_CONFIG_KEY_PREVIOUS,
    ),
    total: inspected.length,
    current: inspected.filter((item) => item.secretSlot === "current").length,
    previous: inspected.filter((item) => item.secretSlot === "previous").length,
    unreadable: inspected.filter((item) => item.secretSlot === "unreadable")
      .length,
  };
}

export async function migrateLandingCredentialsToCurrentKey(
  env: Env,
): Promise<LandingCredentialRotationStatus & { migrated: number }> {
  if (
    !previousSecretConfigured(
      env.LANDING_CONFIG_KEY,
      env.LANDING_CONFIG_KEY_PREVIOUS,
    )
  ) {
    throw new Error("未配置不同于当前密钥的落地配置过渡密钥");
  }
  const inspected = await Promise.all((await rows(env)).map((row) =>
    inspectRow(env, row)
  ));
  const unreadable = inspected.filter(
    (item) => item.secretSlot === "unreadable",
  );
  if (unreadable.length > 0) {
    throw new Error(
      `存在 ${unreadable.length} 条无法解密的落地机凭据，已拒绝迁移`,
    );
  }
  const migrations = inspected.filter(
    (item): item is typeof item & { credential: LandingCredential } =>
      item.secretSlot === "previous" && item.credential !== null,
  );
  const statements: D1PreparedStatement[] = [];
  for (const item of migrations) {
    const encrypted = await sealJson(
      env.LANDING_CONFIG_KEY,
      item.credential,
      `landing:${item.row.id}`,
    );
    statements.push(
      env.DB.prepare(
        `UPDATE landings
         SET credential_enc=?2
         WHERE id=?1 AND credential_enc=?3`,
      ).bind(item.row.id, encrypted, item.row.credential_enc),
    );
  }
  for (let offset = 0; offset < statements.length; offset += 50) {
    await env.DB.batch(statements.slice(offset, offset + 50));
  }
  return {
    ...(await landingCredentialRotationStatus(env)),
    migrated: migrations.length,
  };
}
