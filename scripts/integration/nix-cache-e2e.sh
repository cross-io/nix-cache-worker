#!/usr/bin/env bash

set -euo pipefail

required_variables=(CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN NIX_CACHE_TESTING_URL NIX_CACHE_TESTING_READ_TOKEN NIX_CACHE_TESTING_WRITE_TOKEN NIX_CACHE_TESTING_ADMIN_TOKEN)
for variable_name in "${required_variables[@]}"; do
  if [[ -z "${!variable_name:-}" ]]; then
    printf '%s is required\n' "$variable_name" >&2
    exit 1
  fi
done

base_url="${NIX_CACHE_TESTING_URL%/}"
if [[ ! "$base_url" =~ ^https://[^/]+$ ]]; then
  printf 'NIX_CACHE_TESTING_URL must be an HTTPS origin without a path\n' >&2
  exit 1
fi

temporary_directory="$(mktemp -d)"
cleanup_keys_file="$temporary_directory/cleanup-keys"
test_package=""
test_version=""

cleanup_failed_run() {
  local exit_status="$?" key_list cleanup_keys_json deleted_keys_file deleted_key_list object_key
  trap - EXIT
  if [[ "$exit_status" -ne 0 && -s "$cleanup_keys_file" ]]; then
    printf 'Best-effort cleanup of partial integration-test objects...\n' >&2
    key_in_list="$(sed "s/^/'/; s/$/'/" "$cleanup_keys_file" | paste -sd, -)"
    # SQLite needs one parenthesized row per key: VALUES ('a'),('b').
    # A single VALUES ('a','b') row has two columns and fails against the
    # one-column requested(r2_key) CTE.
    key_values_list="$(sed "s/^/('/; s/$/')/" "$cleanup_keys_file" | paste -sd, -)"
    if [[ -n "$test_package" && -n "$test_version" ]]; then
      npx wrangler d1 execute nix-cache-testing --remote --config wrangler.integration.generated.jsonc --command "DELETE FROM artifact_version_members WHERE version_id IN (SELECT version_id FROM artifact_versions WHERE package_name = '$test_package' AND version_name = '$test_version'); UPDATE objects SET version_member_count = (SELECT COUNT(*) FROM artifact_version_members m WHERE m.narinfo_key = objects.r2_key); DELETE FROM narinfo_refs WHERE narinfo_key IN ($key_in_list) AND NOT EXISTS (SELECT 1 FROM artifact_version_members m WHERE m.narinfo_key = narinfo_refs.narinfo_key); UPDATE objects SET narinfo_ref_count = (SELECT COUNT(*) FROM narinfo_refs r WHERE r.nar_key = objects.r2_key); DELETE FROM artifact_versions WHERE package_name = '$test_package' AND version_name = '$test_version'; DELETE FROM artifact_packages WHERE package_name = '$test_package' AND NOT EXISTS (SELECT 1 FROM artifact_versions v WHERE v.package_name = artifact_packages.package_name);" >/dev/null 2>&1 || true
    fi
    cleanup_keys_json="$(npx wrangler d1 execute nix-cache-testing --remote --json --config wrangler.integration.generated.jsonc --command "WITH requested(r2_key) AS (VALUES $key_values_list) SELECT requested.r2_key FROM requested LEFT JOIN objects ON objects.r2_key = requested.r2_key WHERE objects.r2_key IS NULL OR ((objects.kind = 'narinfo' AND objects.version_member_count = 0 AND NOT EXISTS (SELECT 1 FROM artifact_version_members m WHERE m.narinfo_key = objects.r2_key)) OR (objects.kind = 'nar' AND objects.narinfo_ref_count = 0));" 2>/dev/null || true)"
    deleted_keys_file="$temporary_directory/deleted-cleanup-keys"
    while IFS= read -r object_key; do
      [[ -n "$object_key" ]] || continue
      if npx wrangler r2 object delete "nix-cache-testing/$object_key" --remote --config wrangler.integration.generated.jsonc >/dev/null 2>&1; then
        printf '%s\n' "$object_key" >> "$deleted_keys_file"
      else
        printf 'Could not delete partial integration-test object; it may remain in R2: %s\n' "$object_key" >&2
      fi
    done < <(jq --raw-output '.[].results[]?.r2_key' <<<"$cleanup_keys_json" 2>/dev/null || true)
    if [[ -s "$deleted_keys_file" ]]; then
      deleted_key_list="$(sed "s/^/'/; s/$/'/" "$deleted_keys_file" | paste -sd, -)"
      npx wrangler d1 execute nix-cache-testing --remote --config wrangler.integration.generated.jsonc --command "DELETE FROM objects WHERE r2_key IN ($deleted_key_list) AND ((kind = 'narinfo' AND version_member_count = 0 AND NOT EXISTS (SELECT 1 FROM artifact_version_members m WHERE m.narinfo_key = objects.r2_key)) OR (kind = 'nar' AND narinfo_ref_count = 0));" >/dev/null 2>&1 || true
    fi
  fi
  rm -rf "$temporary_directory"
  exit "$exit_status"
}

trap cleanup_failed_run EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

cache_host="${base_url#https://}"
netrc_file="$temporary_directory/netrc"
printf 'machine %s login nix password %s\n' "$cache_host" "$NIX_CACHE_TESTING_WRITE_TOKEN" > "$netrc_file"
chmod 600 "$netrc_file"
read_netrc_file="$temporary_directory/read-netrc"
printf 'machine %s login nix password %s\n' "$cache_host" "$NIX_CACHE_TESTING_READ_TOKEN" > "$read_netrc_file"
chmod 600 "$read_netrc_file"
invalid_read_netrc_file="$temporary_directory/invalid-read-netrc"
printf 'machine %s login nix password intentionally-invalid-read-token\n' "$cache_host" > "$invalid_read_netrc_file"
chmod 600 "$invalid_read_netrc_file"

retry_cache_request() {
  local attempt output response_status response_file response_headers head_request=0
  if [[ "${1:-}" == "--head" ]]; then
    head_request=1
    shift
  fi
  response_file="$temporary_directory/cache-response"
  response_headers="$temporary_directory/cache-response-headers"
  for attempt in $(seq 1 15); do
    if (( head_request )); then
      if ! response_status="$(curl --silent --show-error --location --head --dump-header "$response_headers" --output /dev/null --write-out '%{http_code}' "$@")"; then
        response_status="000"
      fi
    elif ! response_status="$(curl --silent --show-error --location --output "$response_file" --write-out '%{http_code}' "$@")"; then
      response_status="000"
    fi
    if [[ "$response_status" =~ ^2[0-9][0-9]$ ]]; then
      if (( head_request )); then output="$(<"$response_headers")"; else output="$(<"$response_file")"; fi
      printf '%s' "$output"
      return 0
    fi
    printf 'Cache request attempt %s returned HTTP %s\n' "$attempt" "$response_status" >&2
    sleep 2
  done
  printf 'Cache object did not become available after 30 seconds: %s\n' "$*" >&2
  return 1
}

retry_cache_status() {
  local expected_status="$1"
  shift
  local attempt response_status
  for attempt in $(seq 1 15); do
    if ! response_status="$(curl --silent --show-error --location --output /dev/null --write-out '%{http_code}' "$@")"; then
      response_status="000"
    fi
    if [[ "$response_status" == "$expected_status" ]]; then
      return 0
    fi
    printf 'Cache status attempt %s expected HTTP %s but received %s\n' "$attempt" "$expected_status" "$response_status" >&2
    sleep 2
  done
  return 1
}

retry_direct_r2_redirect() {
  local attempt response_status response_headers location
  response_headers="$temporary_directory/direct-redirect-headers"
  for attempt in $(seq 1 15); do
    if ! response_status="$(curl --silent --show-error --dump-header "$response_headers" --output /dev/null --write-out '%{http_code}' "$@")"; then
      response_status="000"
    fi
    location="$(awk 'BEGIN { IGNORECASE = 1 } /^location:/ { sub(/^[^:]*:[[:space:]]*/, ""); sub(/\r$/, ""); print; exit }' "$response_headers" 2>/dev/null || true)"
    if [[ "$response_status" == "307" && "$location" =~ ^https://[[:xdigit:]]{32}\.r2\.cloudflarestorage\.com/.*X-Amz-Algorithm=AWS4-HMAC-SHA256 ]]; then
      return 0
    fi
    printf 'Direct-read attempt %s did not return a signed R2 redirect (HTTP %s)\n' "$attempt" "$response_status" >&2
    sleep 2
  done
  return 1
}

retry_nix_store_cat_sha256() {
  local store_path="$1"
  local netrc_path="${2:-}"
  local attempt digest
  for attempt in $(seq 1 15); do
    if [[ -n "$netrc_path" ]]; then
      if ! digest="$(nix --option require-sigs false --option netrc-file "$netrc_path" store cat --store "$base_url" "$store_path/payload" | sha256sum | awk '{print $1}')"; then
        digest=""
      fi
    else
      if ! digest="$(nix --option require-sigs false store cat --store "$base_url" "$store_path/payload" | sha256sum | awk '{print $1}')"; then
        digest=""
      fi
    fi
    if [[ -n "$digest" ]]; then
      printf '%s' "$digest"
      return 0
    fi
    printf 'Nix cache read attempt %s failed; retrying\n' "$attempt" >&2
    sleep 2
  done
  printf 'Nix could not read %s after 30 seconds\n' "$store_path" >&2
  return 1
}

assert_nix_store_cat_rejects_invalid_credentials() {
  local store_path="$1" netrc_path="$2"
  if nix --option require-sigs false --option netrc-file "$netrc_path" store cat --store "$base_url" "$store_path/payload" > /dev/null 2>&1; then
    printf 'Nix read unexpectedly accepted invalid READ_TOKEN credentials\n' >&2
    return 1
  fi
}

retry_cache_status 401 "$base_url/nix-cache-info"
cache_info="$(retry_cache_request --netrc-file "$read_netrc_file" "$base_url/nix-cache-info")"
if ! grep --quiet '^StoreDir: /nix/store$' <<<"$cache_info"; then
  printf 'NIX_CACHE_TESTING_URL did not serve the expected Nix cache information\n' >&2
  exit 1
fi

run_identifier="${GITHUB_RUN_ID:-manual}-${GITHUB_RUN_ATTEMPT:-0}"
small_source="$temporary_directory/small-source"
large_source="$temporary_directory/large-source"
mkdir -p "$small_source" "$large_source"

# Random input keeps XZ from shrinking the test NAR below the intended wire size.
dd if=/dev/urandom of="$small_source/payload" bs=1M count=8 status=none
dd if=/dev/urandom of="$large_source/payload" bs=1M count=128 status=none

small_expected_sha256="$(sha256sum "$small_source/payload" | awk '{print $1}')"
large_expected_sha256="$(sha256sum "$large_source/payload" | awk '{print $1}')"

small_store_path="$(nix store add-path --name "nix-cache-e2e-small-$run_identifier" "$small_source")"
large_store_path="$(nix store add-path --name "nix-cache-e2e-large-$run_identifier" "$large_source")"
test_package="nix-cache-e2e-${GITHUB_RUN_ID:-manual}"
test_version="attempt-${GITHUB_RUN_ATTEMPT:-0}"

# Record every deterministic final object key before publishing. The EXIT trap
# can then remove partially uploaded test objects that never reach a version.
expected_file_cache="$temporary_directory/expected-file-cache"
mkdir -p "$expected_file_cache"
nix copy --to "file://$expected_file_cache" "$small_store_path" "$large_store_path"
while IFS= read -r expected_narinfo_file; do
  expected_narinfo_key="$(basename "$expected_narinfo_file")"
  expected_nar_key="$(awk '$1 == "URL:" { print $2; exit }' "$expected_narinfo_file")"
  if [[ ! "$expected_narinfo_key" =~ ^[A-Za-z0-9._~-]+\.narinfo$ || ! "$expected_nar_key" =~ ^nar/[A-Za-z0-9._~/-]+$ || "$expected_nar_key" == *..* ]]; then
    printf 'Nix generated an unsafe integration-test object key\n' >&2
    exit 1
  fi
  printf '%s\n%s\n' "$expected_narinfo_key" "$expected_nar_key" >> "$cleanup_keys_file"
done < <(find "$expected_file_cache" -maxdepth 1 -type f -name '*.narinfo' -print | sort)
sort -u "$cleanup_keys_file" > "$cleanup_keys_file.sorted"
mv "$cleanup_keys_file.sorted" "$cleanup_keys_file"

client_output="$temporary_directory/nix-cache-upload.log"
printf 'Publishing the small and over-100 MiB paths with nix-cache-upload...\n'
NIX_CACHE_WRITE_TOKEN="$NIX_CACHE_TESTING_WRITE_TOKEN" \
  bin/nix-cache-upload \
    --to "$base_url" \
    --package "$test_package" \
    --version "$test_version" \
    --tag integration=real-nix \
    "$small_store_path" "$large_store_path" | tee "$client_output"

largest_client_nar_size="$(awk -F'[()]' '/^Preparing direct upload for / { value = $2; sub(/ bytes$/, "", value); if (value > largest) largest = value } END { print largest + 0 }' "$client_output")"
if [[ "$largest_client_nar_size" -le $((100 * 1024 * 1024)) ]]; then
  printf 'nix-cache-upload did not produce an over-100 MiB direct NAR\n' >&2
  exit 1
fi

small_narinfo_key="$(basename "$small_store_path").narinfo"
small_nar_key="$(retry_cache_request --netrc-file "$read_netrc_file" "$base_url/$small_narinfo_key" | awk '$1 == "URL:" { print $2; exit }')"
if [[ -z "$small_nar_key" ]]; then
  printf 'The direct small NAR upload did not publish a usable narinfo\n' >&2
  exit 1
fi
small_nar_size="$(retry_cache_request --head --netrc-file "$read_netrc_file" "$base_url/$small_nar_key" | awk 'BEGIN { IGNORECASE = 1 } /^content-length:/ { print $2 }' | tr -d '\r' | tail -n 1)"
if [[ -z "$small_nar_size" || "$small_nar_size" -ge $((50 * 1024 * 1024)) ]]; then
  printf 'The small NAR did not stay below 50 MiB\n' >&2
  exit 1
fi
small_downloaded_sha256="$(retry_nix_store_cat_sha256 "$small_store_path" "$read_netrc_file")"
if [[ "$small_downloaded_sha256" != "$small_expected_sha256" ]]; then
  printf 'Nix did not retrieve the expected small payload\n' >&2
  exit 1
fi

large_narinfo_key="$(basename "$large_store_path").narinfo"
large_nar_key="$(retry_cache_request --netrc-file "$read_netrc_file" "$base_url/$large_narinfo_key" | awk '$1 == "URL:" { print $2; exit }')"
if [[ -z "$large_nar_key" ]]; then
  printf 'nix-cache-upload did not publish the large narinfo\n' >&2
  exit 1
fi

large_nar_etag="$(retry_cache_request --head --netrc-file "$read_netrc_file" "$base_url/$large_nar_key" | awk 'BEGIN { IGNORECASE = 1 } /^etag:/ { print $2 }' | tr -d '\r' | tail -n 1)"
if [[ -z "$large_nar_etag" ]]; then
  printf 'The direct large-NAR read did not return an ETag\n' >&2
  exit 1
fi
retry_direct_r2_redirect --netrc-file "$read_netrc_file" "$base_url/$large_nar_key"
retry_direct_r2_redirect --head --netrc-file "$read_netrc_file" "$base_url/$large_nar_key"
retry_cache_status 206 --netrc-file "$read_netrc_file" --range 0-0 "$base_url/$large_nar_key"
retry_cache_status 304 --netrc-file "$read_netrc_file" --header "If-None-Match: $large_nar_etag" "$base_url/$large_nar_key"
retry_cache_status 412 --netrc-file "$read_netrc_file" --header 'If-Match: "never-match"' "$base_url/$large_nar_key"

assert_nix_store_cat_rejects_invalid_credentials "$large_store_path" "$invalid_read_netrc_file"
large_downloaded_sha256="$(retry_nix_store_cat_sha256 "$large_store_path" "$read_netrc_file")"
if [[ "$large_downloaded_sha256" != "$large_expected_sha256" ]]; then
  printf 'Nix did not retrieve the expected large payload\n' >&2
  exit 1
fi

deletion_body="$(jq --null-input --compact-output \
  --arg package_name "$test_package" \
  --arg version_name "$test_version" \
  '{confirmPackageName: $package_name, confirmVersionName: $version_name, reason: "Remove completed integration-test objects"}')"
deletion_response="$(curl --fail-with-body --silent --show-error \
  --request DELETE \
  --header "Authorization: Bearer $NIX_CACHE_TESTING_ADMIN_TOKEN" \
  --header 'Content-Type: application/json' \
  --data "$deletion_body" \
  "$base_url/api/admin/packages/$test_package/versions/$test_version")"
deletion_job_id="$(jq --exit-status --raw-output '.jobId' <<<"$deletion_response")"
if [[ -z "$deletion_job_id" ]]; then
  printf 'The integration-test cleanup did not create a deletion job\n' >&2
  exit 1
fi

printf 'Removing completed integration-test objects...\n'
for attempt in $(seq 1 30); do
  deletion_job="$(curl --fail-with-body --silent --show-error \
    --header "Authorization: Bearer $NIX_CACHE_TESTING_ADMIN_TOKEN" \
    "$base_url/api/admin/jobs/$deletion_job_id")"
  deletion_status="$(jq --exit-status --raw-output '.status' <<<"$deletion_job")"
  if [[ "$deletion_status" == "completed" ]]; then
    printf 'Real Nix integration test passed: stock small upload and client-managed direct NAR uploads were readable from the Worker.\n'
    exit 0
  fi
  if [[ "$deletion_status" == "failed" ]]; then
    printf 'The integration-test cleanup job failed\n' >&2
    exit 1
  fi
  sleep 2
done

printf 'The integration-test cleanup job did not complete within 60 seconds\n' >&2
exit 1
