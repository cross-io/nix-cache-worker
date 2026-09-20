#!/usr/bin/env bash

set -euo pipefail

required_variables=(NIX_CACHE_TESTING_URL NIX_CACHE_TESTING_WRITE_TOKEN NIX_CACHE_TESTING_ADMIN_TOKEN)
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
trap 'rm -rf "$temporary_directory"' EXIT

cache_host="${base_url#https://}"
netrc_file="$temporary_directory/netrc"
printf 'machine %s login nix password %s\n' "$cache_host" "$NIX_CACHE_TESTING_WRITE_TOKEN" > "$netrc_file"
chmod 600 "$netrc_file"

retry_cache_request() {
  local attempt output response_status response_file
  response_file="$temporary_directory/cache-response"
  for attempt in $(seq 1 15); do
    if ! response_status="$(curl --silent --show-error --location --output "$response_file" --write-out '%{http_code}' "$@")"; then
      response_status="000"
    fi
    if [[ "$response_status" =~ ^2[0-9][0-9]$ ]]; then
      output="$(<"$response_file")"
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
  local attempt digest
  for attempt in $(seq 1 15); do
    if digest="$(nix --option require-sigs false store cat --store "$base_url" "$store_path/payload" | sha256sum | awk '{print $1}')"; then
      printf '%s' "$digest"
      return 0
    fi
    printf 'Nix cache read attempt %s failed; retrying\n' "$attempt" >&2
    sleep 2
  done
  printf 'Nix could not read %s after 30 seconds\n' "$store_path" >&2
  return 1
}

cache_info="$(retry_cache_request "$base_url/nix-cache-info")"
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

printf 'Uploading the sub-50 MiB NAR with nix copy...\n'
nix --option netrc-file "$netrc_file" copy --to "$base_url" "$small_store_path"

small_narinfo_key="$(basename "$small_store_path").narinfo"
small_nar_key="$(retry_cache_request "$base_url/$small_narinfo_key" | awk '$1 == "URL:" { print $2; exit }')"
if [[ -z "$small_nar_key" ]]; then
  printf 'The small Nix upload did not publish a usable narinfo\n' >&2
  exit 1
fi
small_nar_size="$(retry_cache_request --head "$base_url/$small_nar_key" | awk 'BEGIN { IGNORECASE = 1 } /^content-length:/ { print $2 }' | tr -d '\r' | tail -n 1)"
if [[ -z "$small_nar_size" || "$small_nar_size" -ge $((50 * 1024 * 1024)) ]]; then
  printf 'The small NAR did not stay below 50 MiB\n' >&2
  exit 1
fi

small_downloaded_sha256="$(retry_nix_store_cat_sha256 "$small_store_path")"
if [[ "$small_downloaded_sha256" != "$small_expected_sha256" ]]; then
  printf 'Nix did not retrieve the expected small payload\n' >&2
  exit 1
fi

test_package="nix-cache-e2e-${GITHUB_RUN_ID:-manual}"
test_version="attempt-${GITHUB_RUN_ATTEMPT:-0}"
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

large_narinfo_key="$(basename "$large_store_path").narinfo"
large_nar_key="$(retry_cache_request "$base_url/$large_narinfo_key" | awk '$1 == "URL:" { print $2; exit }')"
if [[ -z "$large_nar_key" ]]; then
  printf 'nix-cache-upload did not publish the large narinfo\n' >&2
  exit 1
fi

large_nar_etag="$(retry_cache_request --head "$base_url/$large_nar_key" | awk 'BEGIN { IGNORECASE = 1 } /^etag:/ { print $2 }' | tr -d '\r' | tail -n 1)"
if [[ -z "$large_nar_etag" ]]; then
  printf 'The direct large-NAR read did not return an ETag\n' >&2
  exit 1
fi
retry_direct_r2_redirect "$base_url/$large_nar_key"
retry_direct_r2_redirect --head "$base_url/$large_nar_key"
retry_cache_status 206 --range 0-0 "$base_url/$large_nar_key"
retry_cache_status 304 --header "If-None-Match: $large_nar_etag" "$base_url/$large_nar_key"
retry_cache_status 412 --header 'If-Match: "never-match"' "$base_url/$large_nar_key"

large_downloaded_sha256="$(retry_nix_store_cat_sha256 "$large_store_path")"
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
