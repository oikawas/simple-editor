#!/bin/sh
# Prints the next build number and records it. Every build of the web,
# Linux, macOS, and iOS apps calls this, so the number goes up by one with
# each build made from this checkout. The count is kept in .build-number at
# the top of the repository, which is not under version control.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
file="${SIMPLE_EDITOR_BUILD_COUNTER:-$root/.build-number}"
lock="$file.lock"

# Builds may run at the same time; mkdir is atomic, so it serves as a lock.
# A lock left behind by a build that was killed is taken over after ~5 s.
tries=0
while ! mkdir "$lock" 2>/dev/null; do
  tries=$((tries + 1))
  if [ "$tries" -ge 100 ]; then break; fi
  sleep 0.05
done

n=$(cat "$file" 2>/dev/null || true)
case "$n" in '' | *[!0-9]*) n=0 ;; esac
n=$((n + 1))
echo "$n" > "$file"
rmdir "$lock" 2>/dev/null || true
echo "$n"
