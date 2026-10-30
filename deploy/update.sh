#!/usr/bin/env bash
set -euo pipefail

src=$(cd "$(dirname "$0")/.." && pwd)
releases=/opt/mahiear/releases
stamp=$(date +%Y%m%d-%H%M%S)
target="$releases/$stamp"
previous=$(readlink -f /opt/mahiear/current || true)

cd "$src"
git pull --ff-only
cargo build --release --locked --manifest-path server/Cargo.toml
(cd web && npm ci --no-audit --no-fund && npm run build)

sudo install -d -o root -g root -m 0755 "$target"
sudo install -m 0755 server/target/release/mahiear-server "$target/mahiear-server"
sudo cp -r web/dist "$target/web"

switch_to() {
	sudo ln -sfn "$1" /opt/mahiear/current.new
	sudo mv -T /opt/mahiear/current.new /opt/mahiear/current
	sudo systemctl restart mahiear
}

healthy() {
	for _ in $(seq 1 30); do
		curl -fsS -o /dev/null --unix-socket /run/mahiear/http.sock http://localhost/api/health && return 0
		sleep 0.5
	done
	return 1
}

switch_to "$target"
if ! healthy; then
	echo "new release failed the health check" >&2
	if [ -n "$previous" ] && [ -d "$previous" ]; then
		switch_to "$previous"
		healthy && echo "rolled back to $(basename "$previous")" >&2
	fi
	exit 1
fi

ls -1dt "$releases"/* | tail -n +4 | xargs -r sudo rm -rf
echo "updated to $stamp"
