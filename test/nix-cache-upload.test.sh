#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd "$(dirname "$0")/.." && pwd)"
client="$repository_root/bin/nix-cache-upload"
temporary_directory="$(mktemp -d)"
trap 'rm -rf -- "$temporary_directory"' EXIT

assert_contains() {
  local needle="$1"
  local file="$2"
  grep -F --quiet -- "$needle" "$file" || {
    printf 'Expected %s in %s\n' "$needle" "$file" >&2
    exit 1
  }
}

make_fake_tools() {
  local scenario="$1"
  local fake_bin="$temporary_directory/$scenario/bin"
  mkdir -p "$fake_bin"
  cat > "$fake_bin/nix" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "copy" && "$2" == "--to" ]]; then
  cache="${3#file://}"
  mkdir -p "$cache/nar"
  printf 'small-data' > "$cache/nar/small.nar.xz"
  printf 'large-data' > "$cache/nar/large.nar.xz"
  cat > "$cache/small.narinfo" <<'INFO'
StorePath: /nix/store/small-small
URL: nar/small.nar.xz
INFO
  cat > "$cache/large.narinfo" <<'INFO'
StorePath: /nix/store/large-large
URL: nar/large.nar.xz
INFO
  cat > "$cache/duplicate.narinfo" <<'INFO'
StorePath: /nix/store/duplicate-small
URL: nar/small.nar.xz
INFO
  exit 0
fi
if [[ "$1 $2 $3 $4" == "hash file --type sha256" ]]; then
  case "$6" in
    *small*) printf '%064d\n' 1 ;;
    *large*) printf '%064d\n' 2 ;;
  esac
  exit 0
fi
exit 1
EOF
  cat > "$fake_bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
config=""
output=""
write_out=""
method="GET"
url=""
data_file=""
arguments="$TEST_STATE_DIR/curl-arguments"
printf '%q ' "$@" >> "$arguments"
printf '\n' >> "$arguments"
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --config) config="$2"; shift 2 ;;
    --output) output="$2"; shift 2 ;;
    --write-out) write_out="$2"; shift 2 ;;
    --request) method="$2"; shift 2 ;;
    --header|--upload-file) shift 2 ;;
    --data-binary) data_file="${2#@}"; shift 2 ;;
    --*) shift ;;
    *) url="$1"; shift ;;
  esac
done
if [[ -n "$config" && -z "$url" ]]; then url="$(awk -F' = "' '$1 == "url" { sub(/"$/, "", $2); print $2 }' "$config")"; fi
if [[ -n "$config" ]]; then
  grep -q 'Authorization: Bearer test-token' "$config" && :
  if grep -q 'r2.cloudflarestorage.com' "$config"; then
    count_file="$TEST_STATE_DIR/direct-put-attempts"
    count=0; [[ -f "$count_file" ]] && count="$(cat "$count_file")"
    count=$((count + 1)); printf '%s' "$count" > "$count_file"
    printf 'direct-put\n' >> "$TEST_CURL_LOG"
    if [[ "$count" == "1" ]]; then printf '412'; else printf '200'; fi
    exit 0
  fi
fi
case "$url" in
  */api/uploads)
    count_file="$TEST_STATE_DIR/uploads"
    count=0; [[ -f "$count_file" ]] && count="$(cat "$count_file")"
    count=$((count + 1)); printf '%s' "$count" > "$count_file"
    printf 'api-upload\n' >> "$TEST_CURL_LOG"
    if [[ "$count" == "1" ]]; then
      printf '{"error":"retry"}' > "$output"; printf '503'
    else
      printf '{"uploadId":"00000000-0000-4000-8000-000000000001","key":"nar/test.nar","size":10,"sha256":"%064d","uploadUrl":"https://ffe78ad8ba17aa52f57892f8eda2a903.r2.cloudflarestorage.com/nix-cache-test/_nix_uploads/00000000-0000-4000-8000-000000000001?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=private","uploadHeaders":{"Content-Type":"application/octet-stream","If-None-Match":"*","Cache-Control":"public, max-age=31536000, immutable"}}' "$count" > "$output"
      printf '201'
    fi
    ;;
  */complete)
    count_file="$TEST_STATE_DIR/complete-attempts"
    count=0; [[ -f "$count_file" ]] && count="$(cat "$count_file")"
    count=$((count + 1)); printf '%s' "$count" > "$count_file"
    printf 'api-complete\n' >> "$TEST_CURL_LOG"
    if [[ "$count" == "1" ]]; then
      printf '{"error":{"code":"upload_not_ready"}}' > "$output"; printf '409'
    else
      printf '{"status":"completed"}' > "$output"; printf '201'
    fi
    ;;
  */api/packages/*/versions/*)
    cp "$data_file" "$TEST_REGISTRATION_BODY"
    printf 'register\n' >> "$TEST_CURL_LOG"
    printf '{"versionId":"test"}' > "$output"; printf '201'
    ;;
  */*.narinfo)
    printf 'narinfo-put\n' >> "$TEST_CURL_LOG"; : > "$output"; printf '201'
    ;;
  *)
    printf 'unexpected URL: %s\n' "$url" >&2; exit 1
    ;;
esac
EOF
  chmod +x "$fake_bin/nix" "$fake_bin/curl"
  printf '%s' "$fake_bin"
}

test_invalid_arguments() {
  if NIX_CACHE_WRITE_TOKEN=test-token "$client" --to http://example.invalid --package demo --version v1 path >"$temporary_directory/invalid.out" 2>&1; then
    printf 'expected invalid cache URL to fail\n' >&2
    exit 1
  fi
  assert_contains '--to must be an HTTPS origin without a path' "$temporary_directory/invalid.out"
}

test_full_publish_flow() {
  local fake_bin
  fake_bin="$(make_fake_tools full)"
  mkdir -p "$temporary_directory/full/state"
  printf 'test-token\n' > "$temporary_directory/full/write-token"
  chmod 600 "$temporary_directory/full/write-token"
  TEST_STATE_DIR="$temporary_directory/full/state" \
  TEST_CURL_LOG="$temporary_directory/full/curl.log" \
  TEST_REGISTRATION_BODY="$temporary_directory/full/registration.json" \
  PATH="$fake_bin:$PATH" \
  NIX_CACHE_WRITE_TOKEN=ignored-token \
  "$client" --to https://cache.example.org --package demo --version build-1 --token-file "$temporary_directory/full/write-token" --tag channel=main --retention-days 12 --retries 1 input-a input-b >"$temporary_directory/full/output" 2>"$temporary_directory/full/error" || {
    cat "$temporary_directory/full/error" >&2
    exit 1
  }

  [[ "$(grep -c '^api-upload$' "$temporary_directory/full/curl.log")" == "3" ]] || {
    printf 'expected two unique NAR sessions plus one retry\n' >&2
    exit 1
  }
  [[ "$(grep -c '^direct-put$' "$temporary_directory/full/curl.log")" == "2" ]] || {
    printf 'expected one direct R2 PUT per unique NAR\n' >&2
    exit 1
  }
  [[ "$(grep -c '^api-complete$' "$temporary_directory/full/curl.log")" == "3" ]] || {
    printf 'expected completion retry after a transient 409\n' >&2
    exit 1
  }
  [[ "$(grep -c '^narinfo-put$' "$temporary_directory/full/curl.log")" == "3" ]] || {
    printf 'expected every narinfo to be published after NAR completion\n' >&2
    exit 1
  }
  last_complete_line="$(grep -n '^api-complete$' "$temporary_directory/full/curl.log" | tail -n 1 | cut -d: -f1)"
  first_narinfo_line="$(grep -n '^narinfo-put$' "$temporary_directory/full/curl.log" | head -n 1 | cut -d: -f1)"
  register_line="$(grep -n '^register$' "$temporary_directory/full/curl.log" | cut -d: -f1)"
  [[ "$first_narinfo_line" -gt "$last_complete_line" && "$register_line" -gt "$first_narinfo_line" ]] || {
    printf 'narinfo publication or registration occurred before NAR completion\n' >&2
    exit 1
  }
  assert_contains '"narinfoKeys": [' "$temporary_directory/full/registration.json"
  assert_contains '"channel": "main"' "$temporary_directory/full/registration.json"
  assert_contains '"retentionDays": 12' "$temporary_directory/full/registration.json"
  [[ "$(jq '.narinfoKeys | length' "$temporary_directory/full/registration.json")" == "3" ]] || {
    printf 'expected all generated narinfos in the registered version\n' >&2
    exit 1
  }
  if grep -F --quiet -- 'test-token' "$temporary_directory/full/output" "$temporary_directory/full/error" "$temporary_directory/full/state/curl-arguments"; then
    printf 'write token leaked from the client\n' >&2
    exit 1
  fi
  if grep -F --quiet -- 'X-Amz-Signature=private' "$temporary_directory/full/output" "$temporary_directory/full/error" "$temporary_directory/full/state/curl-arguments"; then
    printf 'presigned URL leaked from the client\n' >&2
    exit 1
  fi
}

test_single_put_limit() {
  local fake_bin
  fake_bin="$(make_fake_tools limit)"
  cat > "$fake_bin/wc" <<'EOF'
#!/usr/bin/env bash
printf '5368709121\n'
EOF
  chmod +x "$fake_bin/wc"
  mkdir -p "$temporary_directory/limit/state"
  if TEST_STATE_DIR="$temporary_directory/limit/state" \
    TEST_CURL_LOG="$temporary_directory/limit/curl.log" \
    TEST_REGISTRATION_BODY="$temporary_directory/limit/registration.json" \
    PATH="$fake_bin:$PATH" \
    NIX_CACHE_WRITE_TOKEN=test-token \
    "$client" --to https://cache.example.org --package demo --version too-large input >"$temporary_directory/limit/output" 2>"$temporary_directory/limit/error"; then
    printf 'expected a NAR above the single-PUT limit to fail\n' >&2
    exit 1
  fi
  if ! grep -F --quiet -- 'exceeds the 5 GiB single-PUT R2 limit' "$temporary_directory/limit/error"; then
    cat "$temporary_directory/limit/error" >&2
    printf 'expected the single-PUT limit diagnostic\n' >&2
    exit 1
  fi
  [[ ! -e "$temporary_directory/limit/curl.log" ]] || {
    printf 'the client attempted a direct upload above the single-PUT limit\n' >&2
    exit 1
  }
}

test_invalid_arguments
test_full_publish_flow
test_single_put_limit
printf 'nix-cache-upload shell tests passed\n'
