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

cache_info="$(curl --fail --silent --show-error --retry 5 --retry-all-errors --retry-delay 2 "$base_url/nix-cache-info")"
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
small_nar_key="$(curl --fail --silent --show-error "$base_url/$small_narinfo_key" | awk '$1 == "URL:" { print $2; exit }')"
if [[ -z "$small_nar_key" ]]; then
  printf 'The small Nix upload did not publish a usable narinfo\n' >&2
  exit 1
fi
small_nar_size="$(curl --fail --silent --show-error --head "$base_url/$small_nar_key" | awk 'BEGIN { IGNORECASE = 1 } /^content-length:/ { print $2 }' | tr -d '\r' | tail -n 1)"
if [[ -z "$small_nar_size" || "$small_nar_size" -ge $((50 * 1024 * 1024)) ]]; then
  printf 'The small NAR did not stay below 50 MiB\n' >&2
  exit 1
fi

small_downloaded_sha256="$(nix --option require-sigs false store cat --store "$base_url" "$small_store_path/payload" | sha256sum | awk '{print $1}')"
if [[ "$small_downloaded_sha256" != "$small_expected_sha256" ]]; then
  printf 'Nix did not retrieve the expected small payload\n' >&2
  exit 1
fi

printf 'Generating a canonical Nix cache entry for the over-100 MiB NAR...\n'
large_file_cache="$temporary_directory/large-file-cache"
mkdir -p "$large_file_cache"
nix copy --to "file://$large_file_cache" "$large_store_path"

large_narinfo_file="$(find "$large_file_cache" -maxdepth 1 -type f -name '*.narinfo' -print -quit)"
if [[ -z "$large_narinfo_file" ]]; then
  printf 'Nix did not generate a narinfo file for the large payload\n' >&2
  exit 1
fi

large_narinfo_key="$(basename "$large_narinfo_file")"
large_nar_key="$(awk '$1 == "URL:" { print $2; exit }' "$large_narinfo_file")"
large_nar_file="$large_file_cache/$large_nar_key"
if [[ ! -f "$large_nar_file" ]]; then
  printf 'The NAR referenced by the generated narinfo is missing\n' >&2
  exit 1
fi

large_nar_size="$(wc -c < "$large_nar_file" | tr -d '[:space:]')"
if [[ "$large_nar_size" -le $((100 * 1024 * 1024)) ]]; then
  printf 'The large NAR is not larger than 100 MiB\n' >&2
  exit 1
fi
large_nar_sha256="$(sha256sum "$large_nar_file" | awk '{print $1}')"

upload_request="$(jq --null-input --compact-output \
  --arg key "$large_nar_key" \
  --arg sha256 "$large_nar_sha256" \
  --argjson size "$large_nar_size" \
  '{key: $key, size: $size, sha256: $sha256}')"
upload_session="$(curl --fail-with-body --silent --show-error \
  --request POST \
  --header "Authorization: Bearer $NIX_CACHE_TESTING_WRITE_TOKEN" \
  --header 'Content-Type: application/json' \
  --data "$upload_request" \
  "$base_url/api/uploads")"
upload_id="$(jq --exit-status --raw-output '.uploadId' <<<"$upload_session")"
upload_url="$(jq --exit-status --raw-output '.uploadUrl' <<<"$upload_session")"
upload_content_type="$(jq --exit-status --raw-output '.uploadHeaders["Content-Type"]' <<<"$upload_session")"
upload_if_none_match="$(jq --exit-status --raw-output '.uploadHeaders["If-None-Match"]' <<<"$upload_session")"
if [[ -z "$upload_id" || -z "$upload_url" || -z "$upload_content_type" || -z "$upload_if_none_match" ]]; then
  printf 'The direct-upload API returned an incomplete session\n' >&2
  exit 1
fi

printf 'Uploading the over-100 MiB NAR directly to R2...\n'
curl --fail --silent --show-error \
  --request PUT \
  --header "Content-Type: $upload_content_type" \
  --header "If-None-Match: $upload_if_none_match" \
  --upload-file "$large_nar_file" \
  "$upload_url" \
  --output /dev/null

completion_response="$(curl --fail-with-body --silent --show-error \
  --request POST \
  --header "Authorization: Bearer $NIX_CACHE_TESTING_WRITE_TOKEN" \
  "$base_url/api/uploads/$upload_id/complete")"
if [[ "$(jq --exit-status --raw-output '.status' <<<"$completion_response")" != "completed" ]]; then
  printf 'The direct-upload completion API did not complete the session\n' >&2
  exit 1
fi

printf 'Publishing the Nix-generated narinfo through the standard PUT path...\n'
curl --fail-with-body --silent --show-error \
  --netrc-file "$netrc_file" \
  --upload-file "$large_narinfo_file" \
  "$base_url/$large_narinfo_key" \
  --output /dev/null

large_downloaded_sha256="$(nix --option require-sigs false store cat --store "$base_url" "$large_store_path/payload" | sha256sum | awk '{print $1}')"
if [[ "$large_downloaded_sha256" != "$large_expected_sha256" ]]; then
  printf 'Nix did not retrieve the expected large payload\n' >&2
  exit 1
fi

test_package="nix-cache-e2e-${GITHUB_RUN_ID:-manual}"
test_version="attempt-${GITHUB_RUN_ATTEMPT:-0}"
registration_body="$(jq --null-input --compact-output \
  --arg small_narinfo_key "$small_narinfo_key" \
  --arg large_narinfo_key "$large_narinfo_key" \
  '{narinfoKeys: [$small_narinfo_key, $large_narinfo_key]}')"
curl --fail-with-body --silent --show-error \
  --request PUT \
  --header "Authorization: Bearer $NIX_CACHE_TESTING_WRITE_TOKEN" \
  --header 'Content-Type: application/json' \
  --data "$registration_body" \
  "$base_url/api/packages/$test_package/versions/$test_version" \
  --output /dev/null

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
    printf 'Real Nix integration test passed: standard small upload and direct large upload were both readable from the Worker.\n'
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
