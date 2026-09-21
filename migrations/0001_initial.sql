PRAGMA foreign_keys = ON;

CREATE TABLE artifact_packages (
  package_name TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE objects (
  r2_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('nar', 'narinfo', 'cache-info')),
  etag TEXT NOT NULL,
  sha256 TEXT,
  size INTEGER NOT NULL CHECK (size >= 0),
  uploaded_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'ready' CHECK (state IN ('pending', 'ready', 'deleting')),
  narinfo_ref_count INTEGER NOT NULL DEFAULT 0 CHECK (narinfo_ref_count >= 0),
  version_member_count INTEGER NOT NULL DEFAULT 0 CHECK (version_member_count >= 0)
);

CREATE INDEX idx_objects_kind_uploaded ON objects(kind, uploaded_at);
CREATE INDEX idx_objects_deletion ON objects(kind, state, narinfo_ref_count, version_member_count);

CREATE TABLE write_claims (
  r2_key TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_write_claims_expiry ON write_claims(expires_at);

CREATE TABLE upload_sessions (
  id TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL,
  staging_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind = 'nar'),
  expected_size INTEGER NOT NULL CHECK (expected_size >= 0),
  expected_sha256 TEXT NOT NULL CHECK (length(expected_sha256) = 64),
  status TEXT NOT NULL DEFAULT 'issued'
    CHECK (status IN ('issued', 'completed', 'failed', 'expired', 'revoked')),
  object_etag TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_upload_sessions_expiry ON upload_sessions(status, expires_at);
CREATE INDEX idx_upload_sessions_key ON upload_sessions(r2_key, status, created_at DESC);
CREATE UNIQUE INDEX idx_upload_sessions_active_key
  ON upload_sessions(r2_key)
  WHERE status = 'issued';

CREATE TABLE narinfo_refs (
  narinfo_key TEXT PRIMARY KEY REFERENCES objects(r2_key),
  nar_key TEXT NOT NULL REFERENCES objects(r2_key),
  store_path TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_narinfo_refs_nar ON narinfo_refs(nar_key);

CREATE TABLE artifact_versions (
  version_id TEXT PRIMARY KEY,
  package_name TEXT NOT NULL REFERENCES artifact_packages(package_name),
  version_name TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '{}',
  retention_days INTEGER,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  registered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('registering', 'active', 'deleting', 'deleted')),
  registration_token TEXT,
  UNIQUE(package_name, version_name)
);

CREATE INDEX idx_artifact_versions_package_registered
  ON artifact_versions(package_name, registered_at DESC);

CREATE TABLE artifact_version_members (
  version_id TEXT NOT NULL REFERENCES artifact_versions(version_id) ON DELETE CASCADE,
  narinfo_key TEXT NOT NULL,
  PRIMARY KEY (version_id, narinfo_key)
);

CREATE INDEX idx_artifact_version_members_narinfo ON artifact_version_members(narinfo_key);

CREATE TABLE artifact_version_pending_members (
  version_id TEXT NOT NULL REFERENCES artifact_versions(version_id) ON DELETE CASCADE,
  registration_token TEXT NOT NULL,
  narinfo_key TEXT NOT NULL,
  PRIMARY KEY (version_id, registration_token, narinfo_key)
);

CREATE INDEX idx_artifact_version_pending_members_token
  ON artifact_version_pending_members(version_id, registration_token);

CREATE TABLE gc_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  conditions_json TEXT NOT NULL DEFAULT '[]',
  group_by_json TEXT NOT NULL DEFAULT '[]',
  last_n INTEGER CHECK (last_n IS NULL OR (last_n >= 0 AND last_n <= 100000)),
  duration_days INTEGER CHECK (duration_days IS NULL OR (duration_days >= 0 AND duration_days <= 36500)),
  capacity_versions INTEGER CHECK (capacity_versions IS NULL OR (capacity_versions >= 0 AND capacity_versions <= 100000)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_gc_policies_updated ON gc_policies(updated_at DESC);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('gc', 'delete_version')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'failed', 'completed')),
  target_version_id TEXT,
  cursor INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL DEFAULT '{}',
  last_error TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_jobs_status_updated ON jobs(status, updated_at);
CREATE UNIQUE INDEX idx_jobs_active_delete_target
  ON jobs(target_version_id)
  WHERE type = 'delete_version'
    AND target_version_id IS NOT NULL
    AND status IN ('queued', 'running', 'failed');

CREATE TABLE job_object_items (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  object_kind TEXT NOT NULL CHECK (object_kind IN ('nar', 'narinfo')),
  PRIMARY KEY (job_id, object_key, object_kind)
);

CREATE INDEX idx_job_object_items_job ON job_object_items(job_id, object_kind, object_key);

CREATE TABLE gc_scan_versions (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (job_id, version_id)
);

CREATE INDEX idx_gc_scan_versions_job_version ON gc_scan_versions(job_id, version_id);

CREATE TABLE gc_policy_matches (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL,
  policy_id INTEGER NOT NULL,
  group_key TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  keep_count INTEGER,
  capacity_versions INTEGER,
  PRIMARY KEY (job_id, version_id, policy_id)
);

CREATE INDEX idx_gc_policy_matches_job_group
  ON gc_policy_matches(job_id, policy_id, group_key, registered_at DESC);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  target TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX idx_audit_log_created ON audit_log(created_at DESC);

INSERT INTO gc_policies (
  name, conditions_json, group_by_json, last_n, duration_days,
  capacity_versions, created_at, updated_at
) VALUES (
  'default-package-tags', '[]', '["pkg_name","pkg_tags"]', 3, NULL,
  NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
