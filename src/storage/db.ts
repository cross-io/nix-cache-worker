import type { Bindings } from "../env";
import type { ObjectKind } from "../domain/keys";

export type ObjectRow = {
  r2_key: string;
  kind: ObjectKind;
  etag: string;
  sha256: string | null;
  size: number;
  uploaded_at: string;
  state: string;
  narinfo_ref_count: number;
  version_member_count: number;
};

export type PackageRow = {
  package_name: string;
  created_at: string;
  updated_at: string;
};

export type VersionRow = {
  version_id: string;
  package_name: string;
  version_name: string;
  tags_json: string;
  retention_days: number | null;
  pinned: number;
  registered_at: string;
  updated_at: string;
  state: string;
  registration_token?: string | null;
};

export function now(): string {
  return new Date().toISOString();
}

export async function getObject(env: Bindings, key: string): Promise<ObjectRow | null> {
  return env.DB.prepare("SELECT * FROM objects WHERE r2_key = ?").bind(key).first<ObjectRow>();
}

export async function upsertObject(env: Bindings, object: {
  key: string;
  kind: ObjectKind;
  etag: string;
  sha256: string | null;
  size: number;
  state?: string;
}): Promise<boolean> {
  const timestamp = now();
  const result = await env.DB.prepare(
    `INSERT INTO objects (r2_key, kind, etag, sha256, size, uploaded_at, state, narinfo_ref_count, version_member_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)
     ON CONFLICT(r2_key) DO UPDATE SET etag = excluded.etag, sha256 = excluded.sha256,
       size = excluded.size, state = excluded.state
     WHERE objects.state != 'deleting'`,
  ).bind(object.key, object.kind, object.etag, object.sha256, object.size, timestamp, object.state ?? "ready").run();
  return result.meta.changes === 1;
}

export async function getVersion(env: Bindings, packageName: string, versionName: string): Promise<VersionRow | null> {
  return env.DB.prepare(
    "SELECT * FROM artifact_versions WHERE package_name = ? AND version_name = ?",
  ).bind(packageName, versionName).first<VersionRow>();
}

export async function getVersionById(env: Bindings, versionId: string): Promise<VersionRow | null> {
  return env.DB.prepare("SELECT * FROM artifact_versions WHERE version_id = ?").bind(versionId).first<VersionRow>();
}

export function parseTags(value: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}
