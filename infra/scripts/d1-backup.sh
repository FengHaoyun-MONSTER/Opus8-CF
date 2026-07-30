#!/usr/bin/env bash
# Export production D1 into an authenticated encrypted envelope, or restore one
# into an explicitly named empty recovery database. Never restores in-place.
set -euo pipefail
cd "$(dirname "$0")/../.."

DATABASE_NAME="${D1_DATABASE_NAME:-opus8cf-db}"
CRYPTO_SCRIPT="infra/scripts/d1-backup-crypto.mjs"

usage() {
  cat >&2 <<'EOF'
usage:
  d1-backup.sh backup <output.opus8bk>
  d1-backup.sh restore <input.opus8bk> <opus8cf-recovery-name>

restore additionally requires:
  OPUS8_RESTORE_CONFIRM=restore:<opus8cf-recovery-name>
EOF
  exit 2
}

require_runtime() {
  : "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
  : "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
  : "${D1_BACKUP_ENCRYPTION_KEY:?D1_BACKUP_ENCRYPTION_KEY is required}"
  command -v node >/dev/null
  command -v wrangler >/dev/null
}

resolve_database_id() {
  local name="$1"
  wrangler d1 list --json 2>/dev/null | D1_LOOKUP_NAME="$name" node -e '
    let input="";
    process.stdin.on("data", chunk => input += chunk).on("end", () => {
      try {
        const name=process.env.D1_LOOKUP_NAME;
        const rows=JSON.parse(input);
        const match=rows.find(row => row.name === name);
        process.stdout.write(match ? String(match.uuid || match.database_id || "") : "");
      } catch {
        process.stdout.write("");
      }
    });
  '
}

write_config() {
  local path="$1"
  local binding="$2"
  local name="$3"
  local id="$4"
  cat >"$path" <<EOF
name = "opus8cf-d1-recovery-tool"
compatibility_date = "2025-01-01"

[[d1_databases]]
binding = "$binding"
database_name = "$name"
database_id = "$id"
EOF
}

export_database() {
  local binding="$1"
  local config="$2"
  local output="$3"
  local attempts="${D1_EXPORT_ATTEMPTS:-6}"
  local delay_seconds="${D1_EXPORT_RETRY_DELAY_SECONDS:-20}"
  local attempt=1
  local status
  local error_log="${output}.stderr"

  while true; do
    if wrangler d1 export "$binding" --remote \
        --config "$config" \
        --output "$output" >/dev/null 2>"$error_log"; then
      rm -f -- "$error_log"
      return 0
    else
      status="$?"
    fi
    if [ "$attempt" -ge "$attempts" ] \
        || ! grep -Fq 'Currently processing a long-running import' "$error_log"; then
      cat "$error_log" >&2
      return "$status"
    fi
    echo "WARN D1 is busy with an import; retrying export attempt=$attempt/$attempts delay=${delay_seconds}s"
    sleep "$delay_seconds"
    attempt=$((attempt + 1))
  done
}

operation="${1:-}"
case "$operation" in
  backup)
    [ "$#" -eq 2 ] || usage
    require_runtime
    output="$2"
    case "$output" in
      *.opus8bk) ;;
      *) echo "ERROR backup output must end in .opus8bk" >&2; exit 3 ;;
    esac
    [ ! -e "$output" ] || {
      echo "ERROR refusing to overwrite existing backup" >&2
      exit 3
    }
    mkdir -p "$(dirname "$output")"
    temp_dir="$(mktemp -d)"
    trap 'rm -rf -- "$temp_dir"' EXIT
    database_id="$(resolve_database_id "$DATABASE_NAME")"
    [ -n "$database_id" ] || {
      echo "ERROR D1 database not found" >&2
      exit 4
    }
    write_config "$temp_dir/wrangler.toml" "BACKUP_DB" "$DATABASE_NAME" "$database_id"
    echo "STEP export-d1"
    export_database "BACKUP_DB" "$temp_dir/wrangler.toml" \
      "$temp_dir/full-export.sql"
    python3 infra/scripts/d1-export-data.py \
      "$temp_dir/full-export.sql" "$temp_dir/data.sql"
    {
      printf '%s\n' '-- Opus8 D1 recovery bundle: authoritative schema followed by exported data.'
      cat packages/control-plane/schema.sql
      printf '\n%s\n' \
        "DELETE FROM runtime_state WHERE key='edge_policy_version' AND value=1 AND updated_at=0;"
      printf '\n%s\n' 'PRAGMA defer_foreign_keys = true;'
      cat "$temp_dir/data.sql"
      printf '\n%s\n' \
        "INSERT OR IGNORE INTO runtime_state (key, value, updated_at) VALUES ('edge_policy_version', 1, 0);"
    } >"$temp_dir/export.sql"
    [ -s "$temp_dir/export.sql" ] || {
      echo "ERROR D1 export is empty" >&2
      exit 5
    }
    grep -Eq 'CREATE TABLE|INSERT INTO' "$temp_dir/export.sql" || {
      echo "ERROR D1 export did not contain an expected SQL statement" >&2
      exit 5
    }
    echo "STEP encrypt-backup"
    node "$CRYPTO_SCRIPT" encrypt "$temp_dir/export.sql" "$output"
    (
      cd "$(dirname "$output")"
      output_name="$(basename "$output")"
      sha256sum "$output_name" >"${output_name}.sha256"
    )
    echo "OK encrypted-backup"
    ;;
  restore)
    [ "$#" -eq 3 ] || usage
    require_runtime
    input="$2"
    target="$3"
    [ -f "$input" ] || {
      echo "ERROR backup file not found" >&2
      exit 3
    }
    if [ "$target" = "$DATABASE_NAME" ]; then
      echo "ERROR in-place production restore is forbidden" >&2
      exit 6
    fi
    printf '%s' "$target" | grep -Eq '^opus8cf-recovery-[a-z0-9-]{3,48}$' || {
      echo "ERROR recovery database name is invalid" >&2
      exit 6
    }
    [ "${OPUS8_RESTORE_CONFIRM:-}" = "restore:$target" ] || {
      echo "ERROR OPUS8_RESTORE_CONFIRM must equal restore:$target" >&2
      exit 6
    }
    target_id="$(resolve_database_id "$target")"
    [ -n "$target_id" ] || {
      echo "ERROR create the recovery D1 database explicitly before restore" >&2
      exit 6
    }
    temp_dir="$(mktemp -d)"
    trap 'rm -rf -- "$temp_dir"' EXIT
    write_config "$temp_dir/wrangler.toml" "RECOVERY_DB" "$target" "$target_id"
    schema_json="$(wrangler d1 execute RECOVERY_DB --remote \
      --config "$temp_dir/wrangler.toml" \
      --command "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type IN ('table','view','trigger') AND name NOT LIKE '_cf_%';" \
      --json)"
    schema_count="$(printf '%s' "$schema_json" | node -e '
      let input="";
      process.stdin.on("data", chunk => input += chunk).on("end", () => {
        try {
          const rows=JSON.parse(input).flatMap(item => item.results || []);
          process.stdout.write(String(Number(rows[0]?.count) || 0));
        } catch {
          process.stdout.write("-1");
        }
      });
    ')"
    [ "$schema_count" = "0" ] || {
      echo "ERROR recovery database must be empty" >&2
      exit 6
    }
    echo "STEP decrypt-backup"
    node "$CRYPTO_SCRIPT" decrypt "$input" "$temp_dir/restore.sql"
    grep -Eq 'CREATE TABLE|INSERT INTO' "$temp_dir/restore.sql" || {
      echo "ERROR decrypted backup did not contain an expected SQL statement" >&2
      exit 5
    }
    echo "STEP restore-recovery-d1"
    wrangler d1 execute RECOVERY_DB --remote \
      --config "$temp_dir/wrangler.toml" \
      --file "$temp_dir/restore.sql" >/dev/null
    validation_json="$(wrangler d1 execute RECOVERY_DB --remote \
      --config "$temp_dir/wrangler.toml" \
      --command "SELECT
        (SELECT COUNT(*) FROM users) AS users,
        (SELECT COUNT(*) FROM nodes) AS nodes,
        (SELECT COUNT(*) FROM landings) AS landings,
        (SELECT COUNT(*) FROM plans) AS plans,
        (SELECT COUNT(*) FROM usage) AS usage_rows;" \
      --json)"
    validation_summary="$(printf '%s' "$validation_json" | node -e '
      let input="";
      process.stdin.on("data", chunk => input += chunk).on("end", () => {
        try {
          const rows=JSON.parse(input).flatMap(item => item.results || []);
          const row=rows[0];
          const keys=["users","nodes","landings","plans","usage_rows"];
          if (!row || keys.some(key => !Number.isInteger(Number(row[key])))) process.exit(1);
          process.stdout.write(keys.map(key => `${key}=${Number(row[key])}`).join(" "));
        } catch {
          process.exit(1);
        }
      });
    ')" || {
      echo "ERROR recovery validation query failed" >&2
      exit 7
    }
    echo "OK recovery-data-validated $validation_summary"
    echo "OK recovery-database-restored name=$target"
    ;;
  *)
    usage
    ;;
esac
