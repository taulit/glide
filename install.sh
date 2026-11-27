#!/usr/bin/env bash
# Installs Glide for the current user: the glided daemon (systemd user service) and the
# GNOME Shell extension. `--browsers` also switches on the browsers' own autoscroll.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
uuid="glide@taulit.github.io"
ext_dir="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$uuid"
config="${XDG_CONFIG_HOME:-$HOME/.config}"

say() { printf '\033[1m%s\033[0m\n' "$*"; }

check_access() {
    local ok=1
    if ! id -nG | tr ' ' '\n' | grep -qx input; then
        echo "  ! you are not in the 'input' group: sudo usermod -aG input \$USER, then log in again"
        ok=0
    fi
    if [[ ! -w /dev/uinput ]]; then
        echo "  ! /dev/uinput is not writable for you. Add a udev rule, e.g.:"
        echo "    echo 'KERNEL==\"uinput\", GROUP=\"input\", MODE=\"0660\", TAG+=\"uaccess\"' | sudo tee /etc/udev/rules.d/60-glide-uinput.rules"
        ok=0
    fi
    [[ $ok == 1 ]] && echo "  input devices and uinput are accessible"
}

install_daemon() {
    say "Building glided"
    cargo build --release --manifest-path "$here/daemon/Cargo.toml"
    install -Dm755 "$here/daemon/target/release/glided" "$HOME/.local/bin/glided"
    install -Dm644 "$here/packaging/glided.service" "$config/systemd/user/glided.service"
    systemctl --user daemon-reload
    systemctl --user enable glided.service >/dev/null
    systemctl --user restart glided.service
    echo "  glided running: $(systemctl --user is-active glided.service)"
}

install_extension() {
    say "Building the extension (TypeScript)"
    if ! command -v pnpm >/dev/null; then
        echo "  ! pnpm is missing: install Node 24 or newer, then: corepack enable pnpm"
        exit 1
    fi
    (cd "$here/extension" && pnpm install --frozen-lockfile --silent && pnpm --silent build)
    say "Installing extension to $ext_dir"
    rm -rf "$ext_dir"
    mkdir -p "$ext_dir"
    cp -r "$here"/extension/build/. "$ext_dir/"
    if gnome-extensions enable "$uuid" 2>/dev/null; then
        echo "  enabled"
    else
        echo "  GNOME Shell has not seen it yet: log out and in once, then run: gnome-extensions enable $uuid"
    fi
}

enable_browsers() {
    say "Switching on the browsers' own autoscroll"
    local pref='user_pref("general.autoScroll", true);'
    for profiles in "$HOME/.mozilla/firefox" "$HOME/.config/mozilla/firefox" "$HOME/.librewolf" "$HOME/.zen"; do
        [[ -d $profiles ]] || continue
        for prefs in "$profiles"/*/prefs.js; do
            [[ -f $prefs ]] || continue
            local user_js
            user_js="$(dirname "$prefs")/user.js"
            if ! grep -qF 'general.autoScroll' "$user_js" 2>/dev/null; then
                echo "$pref" >>"$user_js"
                echo "  Firefox profile $(basename "$(dirname "$prefs")") (restart Firefox)"
            fi
        done
    done
    local flag='--enable-blink-features=MiddleClickAutoscroll'
    for name in chrome chromium brave; do
        local file="$config/$name-flags.conf"
        case $name in
            chrome) command -v google-chrome-stable >/dev/null || continue ;;
            *) command -v "$name" >/dev/null || continue ;;
        esac
        if ! grep -qF "$flag" "$file" 2>/dev/null; then
            echo "$flag" >>"$file"
            echo "  $file (restart the browser)"
        fi
    done
}

say "Checking permissions"
check_access
install_daemon
install_extension
[[ ${1:-} == --browsers ]] && enable_browsers
say "Done. Settings: gnome-extensions prefs $uuid"
