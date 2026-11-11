#!/bin/bash

# Peer identity announcements.  Every mesh device broadcasts its mesh hardif
# MAC together with its LAN address and hostname; the receiver stores the
# announcement so the LuCI status table can show the address and hostname of
# each neighbor.  A broadcast crosses bat0, so this works even when the traffic
# table cannot map the neighbor's LAN MAC to an IP address.
MESHASSISTANT_PORT=47123
MESHASSISTANT_PEERS=/tmp/meshassistant_peers
MESHASSISTANT_PEER_MAX_AGE=120
MESHASSISTANT_ANNOUNCE_INTERVAL=10
# Client names.  Only the DHCP server knows its clients' hostnames (from the
# lease file and the static host reservations); the other mesh devices run no
# dnsmasq and lose a quiet client from their ARP table, so the server
# broadcasts its name table and every receiver keeps it until it expires.
MESHASSISTANT_NAMES=/tmp/meshassistant_names
MESHASSISTANT_NAME_MAX_AGE=120
MESHASSISTANT_LEASES=/tmp/dhcp.leases
# Reverse-DNS answers for clients without a local lease.  A node asks the
# server's dnsmasq on every client listing, and a serial 2-second lookup per
# unnamed client is slow; remember each answer (including "no name") for a
# while so repeated listings do not repeat the lookups.
MESHASSISTANT_RDNS_CACHE=${MESHASSISTANT_RDNS_CACHE:-/tmp/meshassistant_rdns}
MESHASSISTANT_RDNS_TTL=${MESHASSISTANT_RDNS_TTL:-300}
# Client listing.  A client that roams to another mesh node leaves a station
# entry behind on the old access point until hostapd drops it after its own
# inactivity timeout.  That entry keeps the old signal, so listing it made the
# device look connected to two nodes at once; a station whose last frame
# exchange is older than this many seconds is left out of the listing.
MESHASSISTANT_STATION_INACTIVE_MAX=${MESHASSISTANT_STATION_INACTIVE_MAX:-120}
# The network class directory, overridable so the tests can point it at a fake
# tree.  On a running system it is the kernel's own /sys/class/net.
MESHASSISTANT_SYS_CLASS_NET=${MESHASSISTANT_SYS_CLASS_NET:-/sys/class/net}
MESHASSISTANT_LOG=/tmp/meshassistant.log
# Keep the run log bounded: /tmp is RAM-backed and the file is appended to by
# every detached run and by the backup actions, so trim the oldest part once
# it grows past this many bytes.
MESHASSISTANT_LOG_MAX=${MESHASSISTANT_LOG_MAX:-262144}
# LAN watchdog state: the LAN options in effect before the AP Mode address was
# applied, plus the address this run is expected to bring up.
MESHASSISTANT_LAN_STATE=${MESHASSISTANT_LAN_STATE:-/tmp/meshassistant_lan_state}

# DAWN state.  The plugin owns /etc/config/dawn only while client roaming is
# enabled; the marker records that ownership so turning roaming off (or
# removing the package) can put back the configuration that was there before.
DAWN_CONFIG=${DAWN_CONFIG:-/etc/config/dawn}
DAWN_MANAGED=${DAWN_MANAGED:-/etc/meshassistant/dawn_managed}
DAWN_BACKUP=${DAWN_BACKUP:-/etc/meshassistant/dawn.backup}

# Serialized operations.  The peer announcement file has its own lock
# (lock_peers); this one keeps two applies, a restore and an apply, or a
# backup action and an apply from interleaving their UCI writes and log trims.
MESHASSISTANT_LOCK=${MESHASSISTANT_LOCK:-/var/lock/meshassistant.lock}

# Return immediately from LuCI RPC calls: wifi/network restarts may take
# longer than the RPC timeout and can drop the current browser connection.
# The output is appended, so the Run Log tab keeps the record of earlier runs
# and of the backup actions instead of showing only the last detached run.
if [ "$1" = "--detach" ]; then
    shift
    /etc/meshassistant/shell/meshassistant.sh "$@" >>"$MESHASSISTANT_LOG" 2>&1 &
    exit 0
fi

# The original command line, logged at the start of every run so the LuCI
# "Run Log" tab shows what was invoked and with which arguments.
MESHASSISTANT_ARGS="$*"

# ---------------------------------------------------------------------------
# Run log helpers
#
# The detached run appends its stdout/stderr to $MESHASSISTANT_LOG, which the
# LuCI "Run Log" tab displays.  These helpers add a timestamped run header and
# record the UCI options that each commit writes, so the log shows both the
# script being run and the configuration it actually changed.
# ---------------------------------------------------------------------------

log_trim() {
    [ -f "$MESHASSISTANT_LOG" ] || return 0
    [ "$(wc -c <"$MESHASSISTANT_LOG")" -gt "$MESHASSISTANT_LOG_MAX" ] || return 0
    # Rewrite the file in place instead of replacing it: a detached run has
    # its stdout open on this file, and a rename would leave that output
    # writing to an unlinked inode.
    tail -c "$MESHASSISTANT_LOG_MAX" "$MESHASSISTANT_LOG" >"$MESHASSISTANT_LOG.tmp" &&
        cat "$MESHASSISTANT_LOG.tmp" >"$MESHASSISTANT_LOG"
    rm -f "$MESHASSISTANT_LOG.tmp"
}

log_note() {
    printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

# Record one event in the run log file itself.  A detached run writes its
# whole output there, but the backup actions return without --detach so that
# LuCI receives their result; append their audit line here, otherwise the Run
# Log tab would not show that a backup was created, deleted or cleared.
log_append() {
    log_trim
    printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$MESHASSISTANT_LOG"
}

# Write the pending UCI changes for one config (secrets masked) and commit
# them.  Replaces plain "uci commit" so the run log records what changed.
uci_commit() {
    local config="$1" label changes

    label=${config:-all configs}
    changes=$(uci -q changes ${config:+$config} 2>/dev/null)

    if [ -n "$changes" ]; then
        log_note "Committing UCI changes ($label):"
        printf '%s\n' "$changes" \
            | sed -E "s/^([^=]*[._](key|psk|password|wpa_key|shared_key|iv)=).*/\1'***'/" \
            | sed 's/^/    /'
    else
        log_note "No UCI changes to commit ($label)."
    fi

    uci commit ${config:+$config}
}

# Heading for a run: command line, host, and the settings that drive it.
log_run_header() {
    local action="$1" hostname ip key_state role server_dhcp ssid_mode wired_backhaul

    log_trim

    hostname=$(uci -q get system.@system[0].hostname)
    [ -n "$hostname" ] || hostname=$(cat /proc/sys/kernel/hostname 2>/dev/null)
    ip=$(lan_ipv4 2>/dev/null)

    if [ "$(uci -q get meshassistant.config.encryption)" = 1 ]; then
        key_state='enabled'
    else
        key_state='disabled'
    fi

    # Show the effective value where the script applies a default.  role is
    # empty when the form default (Server) was saved, since LuCI omits it.
    role=$(uci -q get meshassistant.config.role)
    role=${role:-server}
    server_dhcp=$(uci -q get meshassistant.config.server_dhcp)
    server_dhcp=${server_dhcp:-1}
    ssid_mode=$(uci -q get meshassistant.config.ssid_mode)
    ssid_mode=${ssid_mode:-same}
    wired_backhaul=$(uci -q get meshassistant.config.wired_backhaul)
    wired_backhaul=${wired_backhaul:-none}

    log_note "============================================================"
    log_note "meshassistant: $action"
    log_note "Command: $0${MESHASSISTANT_ARGS:+ $MESHASSISTANT_ARGS}"
    log_note "Host: ${hostname:-unknown}${ip:+ ($ip)}"
    log_note "Settings: enabled=$(uci -q get meshassistant.config.enabled) role=$role server_dhcp=$server_dhcp"
    log_note "Settings: mesh_radio='$(uci -q get meshassistant.config.apRadio)' ap_radios='$(uci -q get meshassistant.config.wifi_radio)' mlo=$(uci -q get meshassistant.config.mlo) ssid_mode=$ssid_mode wired_backhaul=$wired_backhaul"
    log_note "Wireless: wifi_id='$(uci -q get meshassistant.config.wifi_id)' mesh_id='$(uci -q get meshassistant.config.mesh_id)' encryption=$key_state key='***'"
    log_note "============================================================"
}

# ---------------------------------------------------------------------------
# State helpers
#
# The script changes network, firewall, DHCP, DNS and system settings.  Record
# what it changes in the meshassistant config so that disabling the mesh (or
# switching a node back to a server) restores the previous state instead of
# leaving the device with a modified LAN address, a disabled service or a
# half-deleted firewall.
# ---------------------------------------------------------------------------

# Set an option, preserving multi-value UCI lists.  Passing "a b" to
# "uci set" stores it as a single list element, so add the values one by one
# when the saved value contains several words.
uci_set_value() {
    local key="$1" val="$2" item
    set -- $val
    if [ "$#" -le 1 ]; then
        uci set "$key=$val"
        return
    fi
    uci -q del "$key"
    for item in $val; do
        uci add_list "$key=$item"
    done
}

# Write an optional option; an empty value deletes it so clearing a form
# field cannot leave the previous setting in effect.
uci_set_optional() {
    local key="$1" val="$2"

    if [ -n "$val" ]; then
        uci_set_value "$key" "$val"
    else
        uci -q del "$key"
    fi
}

# Save the value of a UCI option (or the fact that it is unset) under a key in
# the meshassistant config.  $1 = meshassistant.config, $2 = option to save,
# $3 = backup name.
uci_backup_save() {
    local prefix="$1" key="$2" name="$3" val
    if val=$(uci -q get "$key"); then
        uci_set_value "$prefix.$name" "$val"
        uci set "$prefix.${name}_unset=0"
    else
        uci -q del "$prefix.$name"
        uci set "$prefix.${name}_unset=1"
    fi
}

# Restore a value saved by uci_backup_save and drop the backup keys.
uci_backup_restore() {
    local prefix="$1" key="$2" name="$3" val
    if [ "$(uci -q get "$prefix.${name}_unset")" = 1 ]; then
        uci -q del "$key"
    else
        val=$(uci -q get "$prefix.$name")
        uci_set_value "$key" "$val"
    fi
    uci -q del "$prefix.$name"
    uci -q del "$prefix.${name}_unset"
}

# Print the UCI section name of the bridge used by the LAN interface.
lan_bridge_section() {
    local dev section
    dev=$(uci -q get network.lan.device)
    [ -z "$dev" ] && dev=$(uci -q get network.lan.ifname)

    if [ -n "$dev" ]; then
        section=$(uci show network 2>/dev/null \
            | sed -n "s/^network\.\([^.]*\)\.name='$dev'\$/\1/p" \
            | head -n 1)
        if [ -n "$section" ] && [ "$(uci -q get "network.$section.type")" = bridge ]; then
            printf '%s\n' "$section"
            return 0
        fi
    fi

    section=$(uci show network 2>/dev/null \
        | sed -n "s/^network\.\([^.]*\)\.type='bridge'\$/\1/p" \
        | head -n 1)
    [ -n "$section" ] && printf '%s\n' "$section"
}

bridge_add_port() {
    local port="$1" section ports
    section=$(lan_bridge_section)
    if [ -z "$section" ]; then
        echo "No LAN bridge found; cannot add '$port'."
        return 1
    fi
    ports=$(uci -q get "network.$section.ports")
    case " $ports " in
        *" $port "*) return 0 ;;
    esac
    uci add_list "network.$section.ports=$port"
    echo "Added '$port' to the LAN bridge."
}

bridge_del_port() {
    local port="$1" section ports
    section=$(lan_bridge_section)
    [ -z "$section" ] && return 0
    ports=$(uci -q get "network.$section.ports")
    case " $ports " in
        *" $port "*) uci del_list "network.$section.ports=$port"; echo "Removed '$port' from the LAN bridge." ;;
    esac
}

# Find a firewall zone by its name instead of assuming its index.
firewall_zone_section() {
    local name="$1"
    uci show firewall 2>/dev/null \
        | sed -n "s/^firewall\.\([^.]*\)\.name='$name'\$/\1/p" \
        | head -n 1
}

firewall_zone_has_network() {
    local zone="$1" net="$2" section nets
    section=$(firewall_zone_section "$zone")
    [ -z "$section" ] && return 1
    nets=$(uci -q get "firewall.$section.network")
    case " $nets " in
        *" $net "*) return 0 ;;
    esac
    return 1
}

firewall_zone_add_network() {
    local zone="$1" net="$2" section
    section=$(firewall_zone_section "$zone")
    if [ -z "$section" ]; then
        return 1
    fi
    if firewall_zone_has_network "$zone" "$net"; then
        return 0
    fi
    uci add_list "firewall.$section.network=$net"
    echo "Added '$net' to firewall zone '$zone'."
}

firewall_remove_network_everywhere() {
    local net="$1" section name nets
    for section in $(uci show firewall 2>/dev/null \
            | sed -n 's/^firewall\.\([^.]*\)=zone$/\1/p'); do
        nets=$(uci -q get "firewall.$section.network")
        case " $nets " in
            *" $net "*)
                uci del_list "firewall.$section.network=$net"
                name=$(uci -q get "firewall.$section.name")
                echo "Removed '$net' from firewall zone '${name:-$section}'."
                ;;
        esac
    done
}

# Make sure a lan -> wan forwarding rule exists.  A named section is used on
# purpose: creating an anonymous forwarding section and then setting options
# through "uci add" / "@forwarding[-1]" can create extra empty sections.
ensure_lan_wan_forwarding() {
    local section src dest
    for section in $(uci show firewall 2>/dev/null \
            | sed -n 's/^firewall\.\([^.]*\)=forwarding$/\1/p'); do
        src=$(uci -q get "firewall.$section.src")
        dest=$(uci -q get "firewall.$section.dest")
        if [ "$src" = lan ] && [ "$dest" = wan ]; then
            return 0
        fi
    done

    uci set firewall.meshassistant_lan_wan=forwarding
    uci set firewall.meshassistant_lan_wan.src='lan'
    uci set firewall.meshassistant_lan_wan.dest='wan'
    uci set meshassistant.config.forwarding_added=1
    echo "Added a lan to wan firewall forwarding rule."
}

# Disable a service and remember that we did, so it can be restored later.
disable_service_recorded() {
    local service="$1"
    if /etc/init.d/$service enabled; then
        uci set "meshassistant.config.disabled_$service=1"
        uci_commit meshassistant
        /etc/init.d/$service disable >/dev/null 2>&1
        /etc/init.d/$service stop >/dev/null 2>&1
        echo "Disabled and stopped $service."
    else
        echo "$service was already disabled."
    fi
}

restore_service_if_disabled() {
    local service="$1"
    if [ "$(uci -q get "meshassistant.config.disabled_$service")" = 1 ]; then
        /etc/init.d/$service enable >/dev/null 2>&1
        /etc/init.d/$service start >/dev/null 2>&1
        uci -q del "meshassistant.config.disabled_$service"
        uci_commit meshassistant
        echo "Re-enabled $service."
    fi
}

restore_services() {
    local service
    for service in firewall dnsmasq odhcpd; do
        restore_service_if_disabled "$service"
    done
}

# LAN DHCP / IPv6 RA state, used when the server does not provide DHCP.
save_dhcp_lan_state() {
    [ "$(uci -q get meshassistant.config.dhcp_lan_saved)" = 1 ] && return 0
    uci_backup_save meshassistant.config dhcp.lan.ignore lan_ignore_backup
    uci_backup_save meshassistant.config dhcp.lan.ra lan_ra_backup
    uci_backup_save meshassistant.config dhcp.lan.dhcpv6 lan_dhcpv6_backup
    uci set meshassistant.config.dhcp_lan_saved=1
}

restore_dhcp_lan_state() {
    [ "$(uci -q get meshassistant.config.dhcp_lan_saved)" = 1 ] || return 0
    uci_backup_restore meshassistant.config dhcp.lan.ignore lan_ignore_backup
    uci_backup_restore meshassistant.config dhcp.lan.ra lan_ra_backup
    uci_backup_restore meshassistant.config dhcp.lan.dhcpv6 lan_dhcpv6_backup
    uci -q del meshassistant.config.dhcp_lan_saved
    uci_commit dhcp
    echo "Restored the original LAN DHCP settings."
}

# Node LAN address and hostname state.
save_node_lan_state() {
    [ "$(uci -q get meshassistant.config.lan_state_saved)" = 1 ] && return 0
    uci_backup_save meshassistant.config network.lan.proto lan_backup_proto
    uci_backup_save meshassistant.config network.lan.ipaddr lan_backup_ipaddr
    uci_backup_save meshassistant.config network.lan.netmask lan_backup_netmask
    uci_backup_save meshassistant.config network.lan.gateway lan_backup_gateway
    uci_backup_save meshassistant.config network.lan.dns lan_backup_dns
    uci_backup_save meshassistant.config network.lan.peerdns lan_backup_peerdns
    uci set meshassistant.config.lan_state_saved=1
}

restore_node_lan_state() {
    [ "$(uci -q get meshassistant.config.lan_state_saved)" = 1 ] || return 0
    uci_backup_restore meshassistant.config network.lan.proto lan_backup_proto
    uci_backup_restore meshassistant.config network.lan.ipaddr lan_backup_ipaddr
    uci_backup_restore meshassistant.config network.lan.netmask lan_backup_netmask
    uci_backup_restore meshassistant.config network.lan.gateway lan_backup_gateway
    uci_backup_restore meshassistant.config network.lan.dns lan_backup_dns
    uci_backup_restore meshassistant.config network.lan.peerdns lan_backup_peerdns
    uci -q del meshassistant.config.lan_state_saved
    uci_commit network
    echo "Restored the original LAN address."
}

save_hostname_state() {
    [ "$(uci -q get meshassistant.config.hostname_state_saved)" = 1 ] && return 0
    uci_backup_save meshassistant.config system.@system[0].hostname hostname_backup
    uci set meshassistant.config.hostname_state_saved=1
}

restore_hostname_state() {
    [ "$(uci -q get meshassistant.config.hostname_state_saved)" = 1 ] || return 0
    uci_backup_restore meshassistant.config system.@system[0].hostname hostname_backup
    uci -q del meshassistant.config.hostname_state_saved
    uci_commit system
    echo "Restored the original hostname."
}

# ---------------------------------------------------------------------------
# Static LAN validation and watchdog
#
# netifd silently applies a missing netmask as /32 and an empty one as /0.
# With a static address and no usable mask the device still answers ARP, but
# it has no LAN route, so it becomes unreachable while still looking present
# on the upstream router.  Validate the AP Mode values before writing them,
# then verify the address and route after the network reload and restore the
# previous LAN options when the result is broken.
# ---------------------------------------------------------------------------

valid_ipv4() {
    local ip="$1" octet
    case "$ip" in
        ''|0.0.0.0|*[!0-9.]*) return 1 ;;
    esac

    local IFS='.'
    set -- $ip
    [ "$#" -eq 4 ] || return 1

    for octet in "$@"; do
        # Reject empty fields and leading zeros; inet_pton is just as strict.
        case "$octet" in
            ''|0?*) return 1 ;;
        esac
        [ "$octet" -le 255 ] || return 1
    done

    return 0
}

# A netmask is valid when its one bits are contiguous.  0.0.0.0 is rejected
# as well: a /0 LAN would route the whole IPv4 space onto the bridge.
valid_netmask() {
    local mask="$1" a b c d bits host
    valid_ipv4 "$mask" || return 1

    local IFS='.'
    set -- $mask
    a=$1 b=$2 c=$3 d=$4

    bits=$(( (a << 24) | (b << 16) | (c << 8) | d ))
    [ "$bits" -ne 0 ] || return 1

    # The host part must be a run of low one bits (2^n - 1).
    host=$(( (~bits) & 0xffffffff ))
    [ $(( host & (host + 1) )) -eq 0 ]
}

# Prefix length of a valid dotted netmask.
netmask_prefix() {
    local a b c d bits n=0

    local IFS='.'
    set -- $1
    a=$1 b=$2 c=$3 d=$4

    bits=$(( (a << 24) | (b << 16) | (c << 8) | d ))
    while [ "$bits" -ne 0 ]; do
        n=$(( n + (bits & 1) ))
        bits=$(( bits >> 1 ))
    done
    printf '%s\n' "$n"
}

# Print the reason when the AP Mode static values cannot be applied.
validate_static_lan() {
    local ipaddr="$1" netmask="$2" gateway="$3" dns="$4" server

    if [ -z "$ipaddr" ]; then
        echo "Error: 'Static IP Address' is empty; keeping the current LAN address."
        return 1
    fi
    if ! valid_ipv4 "$ipaddr"; then
        echo "Error: 'Static IP Address' '$ipaddr' is not a valid IPv4 address; keeping the current LAN address."
        return 1
    fi
    if [ -z "$netmask" ]; then
        echo "Error: 'IPv4 netmask' is empty; netifd would apply the address as /32 and the device would become unreachable. Keeping the current LAN address."
        return 1
    fi
    if ! valid_netmask "$netmask"; then
        echo "Error: 'IPv4 netmask' '$netmask' is not a valid netmask; keeping the current LAN address."
        return 1
    fi
    if [ -n "$gateway" ] && ! valid_ipv4 "$gateway"; then
        echo "Error: 'Mesh Gateway IP Address' '$gateway' is not a valid IPv4 address; keeping the current LAN address."
        return 1
    fi
    for server in $dns; do
        if ! valid_ipv4 "$server"; then
            echo "Error: 'DNS Server' '$server' is not a valid IPv4 address; keeping the current LAN address."
            return 1
        fi
    done

    return 0
}

# Snapshot the LAN options that are about to be replaced, including whether
# each one was set at all.
lan_state_save() {
    local name value

    : > "$MESHASSISTANT_LAN_STATE"
    for name in proto ipaddr netmask gateway dns peerdns; do
        if value=$(uci -q get "network.lan.$name"); then
            printf 'lan_%s=%s\n' "$name" "$value" >> "$MESHASSISTANT_LAN_STATE"
            printf 'lan_%s_unset=0\n' "$name" >> "$MESHASSISTANT_LAN_STATE"
        else
            printf 'lan_%s_unset=1\n' "$name" >> "$MESHASSISTANT_LAN_STATE"
        fi
    done
}

# Record the static values this run is expected to bring up.
lan_state_expect() {
    {
        printf 'expect_ip=%s\n' "$1"
        printf 'expect_netmask=%s\n' "$2"
        printf 'expect_gateway=%s\n' "$3"
    } >> "$MESHASSISTANT_LAN_STATE"
}

# Put the snapshotted LAN options back.  Removes the state file.
lan_state_restore() {
    local file="$MESHASSISTANT_LAN_STATE" name unset_flag value

    [ -f "$file" ] || return 1

    for name in proto ipaddr netmask gateway dns peerdns; do
        unset_flag=$(sed -n "s/^lan_${name}_unset=//p" "$file" | head -n 1)
        # State files written by older versions have no peerdns entry.
        [ -z "$unset_flag" ] && continue
        if [ "$unset_flag" = 1 ]; then
            uci -q del "network.lan.$name"
        else
            value=$(sed -n "s/^lan_${name}=//p" "$file" | head -n 1)
            uci_set_value "network.lan.$name" "$value"
        fi
    done

    rm -f "$file"
    return 0
}

# Apply the AP Mode DNS setting to a DHCP client LAN interface.  A non-empty
# value replaces the DNS servers advertised by the DHCP server; an empty one
# leaves them in use.
apply_dhcp_lan_dns() {
    local dns="$1" server

    uci -q del network.lan.dns
    uci -q del network.lan.peerdns
    [ -z "$dns" ] && return 0

    for server in $dns; do
        if ! valid_ipv4 "$server"; then
            echo "Error: 'DNS Server' '$server' is not a valid IPv4 address; using the DHCP DNS servers instead."
            return 1
        fi
    done

    for server in $dns; do
        uci add_list network.lan.dns="$server"
    done
    uci set network.lan.peerdns='0'
}

# The address is present with the expected prefix, the LAN has a subnet route
# using it, and a configured gateway has a default route.
lan_static_is_up() {
    local ipaddr="$1" prefix="$2" gateway="$3" dev routes

    dev=$(lan_device)

    ip -4 -o addr show dev "$dev" 2>/dev/null \
        | grep -q " inet ${ipaddr}/${prefix} " || return 1

    routes=$(ip route show dev "$dev" 2>/dev/null)
    printf '%s\n' "$routes" | grep -q "src ${ipaddr} " || \
        printf '%s\n' "$routes" | grep -q "src ${ipaddr}$" || return 1

    if [ -n "$gateway" ]; then
        printf '%s\n' "$routes" | grep -q "^default via ${gateway} " || return 1
    fi

    return 0
}

# Verify the result of a static LAN apply; restore the snapshot when the
# address and route did not come up.  Called after the network reload.
lan_watchdog_check() {
    local file="$MESHASSISTANT_LAN_STATE" ipaddr netmask gateway prefix attempt

    [ "${MESHASSISTANT_LAN_WATCHDOG:-1}" = 0 ] && { rm -f "$file"; return 0; }
    [ -f "$file" ] || return 0

    ipaddr=$(sed -n 's/^expect_ip=//p' "$file" | head -n 1)
    netmask=$(sed -n 's/^expect_netmask=//p' "$file" | head -n 1)
    gateway=$(sed -n 's/^expect_gateway=//p' "$file" | head -n 1)

    if [ -z "$ipaddr" ] || ! valid_netmask "$netmask"; then
        rm -f "$file"
        return 0
    fi

    prefix=$(netmask_prefix "$netmask")

    for attempt in 1 2 3 4 5; do
        sleep "${MESHASSISTANT_LAN_WATCHDOG_DELAY:-3}"
        if lan_static_is_up "$ipaddr" "$prefix" "$gateway"; then
            echo "Verified the LAN address ${ipaddr}/${prefix} after applying."
            rm -f "$file"
            return 0
        fi
    done

    echo "Warning: the LAN address ${ipaddr}/${prefix} did not come up; restoring the previous LAN settings."
    if lan_state_restore; then
        uci_commit network
        /etc/init.d/network reload
        echo "Restored the previous LAN settings (proto=$(uci -q get network.lan.proto), address=$(uci -q get network.lan.ipaddr))."
    else
        echo "Error: no LAN snapshot was available to restore."
    fi
    return 1
}

# Apply the AP Mode tab settings to a node.  This is also used by normal
# enable, not only by Dumb AP mode: IP Mode / static address / gateway /
# netmask / DNS / hostname are the node's management addressing.
apply_node_lan() {
    local ipmode hostname ipaddr netmask gateway dns

    ipmode=$(uci -q get meshassistant.config.ipmode)
    hostname=$(uci -q get meshassistant.config.hostname)
    dns=$(uci -q get meshassistant.config.dns)

    save_node_lan_state

    if [ "$ipmode" = "static" ]; then
        ipaddr=$(uci -q get meshassistant.config.ipaddr)
        netmask=$(uci -q get meshassistant.config.netmask)
        gateway=$(uci -q get meshassistant.config.gateway)

        if validate_static_lan "$ipaddr" "$netmask" "$gateway" "$dns"; then
            lan_state_save

            uci set network.lan.proto='static'
            uci_set_value network.lan.ipaddr "$ipaddr"
            uci_set_value network.lan.netmask "$netmask"
            uci_set_optional network.lan.gateway "$gateway"
            uci_set_optional network.lan.dns "$dns"
            uci -q del network.lan.peerdns

            lan_state_expect "$ipaddr" "$netmask" "$gateway"
            echo "Node LAN configured as static ${ipaddr}/${netmask}."
        else
            # Leave the LAN untouched: an incomplete static configuration
            # would make the device unreachable.
            rm -f "$MESHASSISTANT_LAN_STATE"
        fi
    else
        rm -f "$MESHASSISTANT_LAN_STATE"
        uci set network.lan.proto='dhcp'
        uci -q del network.lan.ipaddr
        uci -q del network.lan.netmask
        uci -q del network.lan.gateway
        apply_dhcp_lan_dns "$dns"
        echo "Node LAN configured as a DHCP client."
    fi

    if [ -n "$hostname" ]; then
        save_hostname_state
        uci set "system.@system[0].hostname=$hostname"
        echo "Node hostname set to '$hostname'."
    fi

    uci_commit network
    uci_commit system
    uci_commit meshassistant
}

# ---------------------------------------------------------------------------
# Wired backhaul
#
# The selected Ethernet port is removed from the LAN bridge and attached to
# bat0 as a batadv_hardif.  Both ends of the cable must select their port.
# BATMAN_V normally rates a wired link by its link speed; the throughput
# override makes the wired link win even when the 802.11s backhaul reports a
# higher rate.  When the cable is unplugged the hardif goes down and BATMAN_V
# automatically falls back to the wireless hardif.
# ---------------------------------------------------------------------------

wired_backhaul_port() {
    local port
    port=$(uci -q get meshassistant.config.wired_backhaul)
    case "$port" in
        ''|none) return 1 ;;
    esac
    printf '%s\n' "$port"
}

wired_port_is_usable() {
    local port="$1" section dev ifn ports lan_section

    case "$port" in
        bat0|mesh_batman|mesh_wired|lo|br-*|none|'') return 1 ;;
    esac
    case "$port" in
        *[!A-Za-z0-9_.-]*|.*) return 1 ;;
    esac

    # A port that already belongs to another logical interface (for example
    # the WAN uplink) cannot be dedicated to backhaul without breaking that
    # interface.  netifd would also try to claim the device twice.
    for section in $(uci show network 2>/dev/null \
            | sed -n 's/^network\.\([^.]*\)=interface$/\1/p'); do
        case "$section" in
            lan|mesh_wired) continue ;;
        esac
        dev=$(uci -q get "network.$section.device")
        ifn=$(uci -q get "network.$section.ifname")
        case " $dev $ifn " in
            *" $port "*) return 1 ;;
        esac
    done

    # Reapplying the same port: it is already the dedicated hardif.
    if [ "$(uci -q get network.mesh_wired.device)" = "$port" ]; then
        return 0
    fi

    # A new port must be a member of the LAN bridge and of no other bridge.
    lan_section=$(lan_bridge_section)
    [ -n "$lan_section" ] || return 1
    ports=$(uci -q get "network.$lan_section.ports")
    case " $ports " in
        *" $port "*) ;;
        *) return 1 ;;
    esac

    for section in $(uci show network 2>/dev/null \
            | sed -n "s/^network\.\([^.]*\)\.type='bridge'\$/\1/p"); do
        [ "$section" = "$lan_section" ] && continue
        ports=$(uci -q get "network.$section.ports")
        case " $ports " in
            *" $port "*) return 1 ;;
        esac
    done

    return 0
}

remove_wired_backhaul() {
    local port restore
    port=$(uci -q get network.mesh_wired.device)
    [ -z "$port" ] && port=$(uci -q get meshassistant.config.wired_backhaul_restore_port)
    restore=$(uci -q get meshassistant.config.wired_backhaul_bridge_removed)

    if uci -q get network.mesh_wired >/dev/null; then
        uci -q del network.mesh_wired
        echo "Removed the wired backhaul interface."
    fi

    if [ "$restore" = 1 ] && [ -n "$port" ]; then
        bridge_add_port "$port"
    fi

    uci -q del meshassistant.config.wired_backhaul_bridge_removed
    uci -q del meshassistant.config.wired_backhaul_restore_port
}

apply_wired_backhaul() {
    local port section ports

    if ! port=$(wired_backhaul_port); then
        remove_wired_backhaul
        return 0
    fi

    # Give the previous port back to the LAN bridge when the selection
    # changes; the new port is removed below.
    if [ "$(uci -q get network.mesh_wired.device)" != "$port" ]; then
        remove_wired_backhaul
    fi

    if ! wired_port_is_usable "$port"; then
        echo "Warning: '$port' cannot be used for wired backhaul; using the Mesh radio."
        remove_wired_backhaul
        return 1
    fi

    section=$(lan_bridge_section)
    if [ -n "$section" ]; then
        ports=$(uci -q get "network.$section.ports")
        case " $ports " in
            *" $port "*)
                uci del_list "network.$section.ports=$port"
                uci set meshassistant.config.wired_backhaul_bridge_removed=1
                uci set meshassistant.config.wired_backhaul_restore_port="$port"
                echo "Removed '$port' from the LAN bridge for wired backhaul."
                ;;
        esac
    fi

    uci set network.mesh_wired=interface
    uci set network.mesh_wired.proto='batadv_hardif'
    uci set network.mesh_wired.master='bat0'
    uci set network.mesh_wired.device="$port"
    uci set network.mesh_wired.mtu='1500'
    uci set network.mesh_wired.throughput_override='100000mbit'
    echo "Wired backhaul enabled on '$port'."
}

# Dumb AP Mode Block
set_apmode() {
    local ipaddr netmask gateway dns

    # Dumb AP mode disables the services and rewrites the LAN interface, so a
    # bad static address would leave the device unreachable with no DHCP
    # server.  Validate before changing anything.
    if [ "$(uci -q get meshassistant.config.ipmode)" = "static" ]; then
        ipaddr=$(uci -q get meshassistant.config.ipaddr)
        netmask=$(uci -q get meshassistant.config.netmask)
        gateway=$(uci -q get meshassistant.config.gateway)
        dns=$(uci -q get meshassistant.config.dns)

        if ! validate_static_lan "$ipaddr" "$netmask" "$gateway" "$dns"; then
            echo "Aborting Dumb AP mode; no configuration was changed."
            return 1
        fi
    fi

    # Back up the configs once, before the first conversion.  Re-applying
    # while Dumb AP mode is already on must keep that original snapshot: the
    # current files have been converted already and would overwrite it.
    if [ "$(uci -q get meshassistant.config.ap_mode_enabled)" != 1 ]; then
        rm -f "$MESHASSISTANT_CONFIG_DIR"/*.meshbak
        cp "$MESHASSISTANT_CONFIG_DIR/wireless" "$MESHASSISTANT_CONFIG_DIR/wireless.meshbak"
        cp "$MESHASSISTANT_CONFIG_DIR/network" "$MESHASSISTANT_CONFIG_DIR/network.meshbak"
        cp "$MESHASSISTANT_CONFIG_DIR/dhcp" "$MESHASSISTANT_CONFIG_DIR/dhcp.meshbak"
        cp "$MESHASSISTANT_CONFIG_DIR/system" "$MESHASSISTANT_CONFIG_DIR/system.meshbak"
        cp "$MESHASSISTANT_CONFIG_DIR/firewall" "$MESHASSISTANT_CONFIG_DIR/firewall.meshbak"
    else
        echo "Dumb AP mode is already enabled; keeping the existing configuration backup."
    fi

    uci set meshassistant.config.ap_mode_enabled=1

    # Disabling and stopping services not needed.  Record which services this
    # disabled so leaving Dumb AP restores exactly those and leaves services
    # the administrator had already turned off alone.
    for service in firewall dnsmasq odhcpd; do
        disable_service_recorded "$service"
    done

    if [ "$(uci -q get meshassistant.config.ipmode)" == "static" ]; then
        # Set static IP.  The values were validated above; write them through
        # the same helpers as apply_node_lan so an empty option is never
        # stored (netifd would turn an empty netmask into /0).
        lan_state_save
        uci set network.lan.proto='static'
        uci_set_value network.lan.ipaddr "$ipaddr"
        uci_set_value network.lan.netmask "$netmask"
        uci_set_optional network.lan.gateway "$gateway"
        uci_set_optional network.lan.dns "$dns"
        uci -q del network.lan.peerdns
        lan_state_expect "$ipaddr" "$netmask" "$gateway"
    else
        # Set LAN interface to DHCP client
        rm -f "$MESHASSISTANT_LAN_STATE"
        dns=$(uci -q get meshassistant.config.dns)
        uci -q del network.lan.ipaddr
        uci -q del network.lan.netmask
        uci -q del network.lan.gateway
        apply_dhcp_lan_dns "$dns"
        uci set network.lan.proto='dhcp'
    fi

    # Delete wan interfaces
    uci -q del network.wan
    uci -q del network.wan6

    # Set firewall disabled
    uci -q del firewall.lan.network
    uci -q del firewall.wan.network

    # Just in case, set lan to be ignored by dhcp
    uci set dhcp.lan.ignore='1'
    uci -q del dhcp.wan

    # Fix this for proper variable name
    HOSTNAME=$(uci -q get meshassistant.config.hostname)
    # An absent hostname means "keep the current one".  Writing it
    # unconditionally would replace the system hostname with an empty string
    # on configs saved before the AP Mode defaults were written to UCI.
    [ -n "$HOSTNAME" ] && uci set system.@system[0].hostname="$HOSTNAME"

    # Add the wan port to the actual LAN bridge (Dumb AP mode turns the WAN
    # port into a LAN port on purpose).
    bridge_add_port wan

    # Get the radio to be used for mesh from the config
    AP_RADIO=$(uci -q get meshassistant.config.apRadio)

    # Our config set mesh_id that we are looking for
    MESH_ID=$(uci -q get meshassistant.config.mesh_id)

    # Check if MESH_NAME and AP_RADIO are set, if so find set our network
    if [ ! -z "$AP_RADIO" ] && [ ! -z "$MESH_ID" ]; then
        # Loop through the radios and update the network settings
        for radio in $AP_RADIO; do
            # Get the number from the radio name
            radio_num="${radio#radio}"
            echo "Checking wireless networks on radio${radio_num} for ssid '$MESH_ID'"

            # Loop through all the wireless interfaces associated with the current radio
            uci show wireless | grep "wireless\.wifinet${radio_num}" | grep '\.ssid=' | while read -r ssid_line; do
                # Extract the interface identifier
                wifinet=$(echo "$ssid_line" | cut -d'.' -f2)
                # Extract the ssid value
                interface_ssid=$(echo "$ssid_line" | cut -d'=' -f2 | tr -d "'")

                if [ "$interface_ssid" = "$MESH_ID" ]; then
                    echo "Found target SSID '$MESH_ID' on wireless wifinet ${wifinet} on radio ${radio}"

                    # Get the current network setting for this wifinet
                    current_network=$(uci get "wireless.${wifinet}.network")
                    echo "Current network setting for ${wifinet}: ${current_network}"

                    # Check if 'mesh_batman' is part of the current network setting
                    if echo "$current_network" | grep -qv 'mesh_batman'; then
                        # 'mesh_batman' is not in the network setting, so we add it
                        new_network="${current_network} mesh_batman"
                        uci set "wireless.${wifinet}.network=${new_network}"
                        echo "Added 'mesh_batman' to the network setting for ${wifinet}."
                        uci_commit wireless
                    else
                        echo "'mesh_batman' is already in the network setting for ${wifinet}."
                    fi
                else
                    echo "SSID '$interface_ssid' on wireless wifinet ${wifinet} does not match target SSID '$MESH_ID'. Skipping..."
                fi
            done
        done
    fi

    # Commit changes to make sure the wireless configuration is updated
    uci_commit

    # Restart wireless
    wifi reload

    # Tell openwrt to reload the configs
    reload_config
    /etc/init.d/network reload

    # Verify the static address and roll it back when it did not come up.
    lan_watchdog_check
}

disable_apmode() {
    # Config Count Must Match 5
    local CONFIG_COUNT=0

    # The meshbak files restore the LAN directly; drop any pending watchdog
    # snapshot from an interrupted apply.
    rm -f "$MESHASSISTANT_LAN_STATE"

    # Check our configs exist, then restore them
    [ -f "$MESHASSISTANT_CONFIG_DIR/wireless.meshbak" ] && {
        CONFIG_COUNT=$((CONFIG_COUNT+1))
    }
    [ -f "$MESHASSISTANT_CONFIG_DIR/network.meshbak" ] && {
        CONFIG_COUNT=$((CONFIG_COUNT+1))
    }
    [ -f "$MESHASSISTANT_CONFIG_DIR/dhcp.meshbak" ] && {
        CONFIG_COUNT=$((CONFIG_COUNT+1))
    }
    [ -f "$MESHASSISTANT_CONFIG_DIR/system.meshbak" ] && {
        CONFIG_COUNT=$((CONFIG_COUNT+1))
    }
    [ -f "$MESHASSISTANT_CONFIG_DIR/firewall.meshbak" ] && {
        CONFIG_COUNT=$((CONFIG_COUNT+1))
    }

    # Check if we have 5 configs to restore
    if [ $CONFIG_COUNT -eq 5 ]; then
        echo "Restoring configs from backup..."
        echo "Existing configs will be moved to ${MESHASSISTANT_CONFIG_DIR}/*.dumbap for reference."
        rm -f "$MESHASSISTANT_CONFIG_DIR"/*.dumbap
        mv "$MESHASSISTANT_CONFIG_DIR/dhcp" "$MESHASSISTANT_CONFIG_DIR/dhcp.dumbap"
        mv "$MESHASSISTANT_CONFIG_DIR/network" "$MESHASSISTANT_CONFIG_DIR/network.dumbap"
        mv "$MESHASSISTANT_CONFIG_DIR/wireless" "$MESHASSISTANT_CONFIG_DIR/wireless.dumbap"
        mv "$MESHASSISTANT_CONFIG_DIR/system" "$MESHASSISTANT_CONFIG_DIR/system.dumbap"
        mv "$MESHASSISTANT_CONFIG_DIR/firewall" "$MESHASSISTANT_CONFIG_DIR/firewall.dumbap"
        mv "$MESHASSISTANT_CONFIG_DIR/dhcp.meshbak" "$MESHASSISTANT_CONFIG_DIR/dhcp"
        mv "$MESHASSISTANT_CONFIG_DIR/network.meshbak" "$MESHASSISTANT_CONFIG_DIR/network"
        mv "$MESHASSISTANT_CONFIG_DIR/wireless.meshbak" "$MESHASSISTANT_CONFIG_DIR/wireless"
        mv "$MESHASSISTANT_CONFIG_DIR/system.meshbak" "$MESHASSISTANT_CONFIG_DIR/system"
        mv "$MESHASSISTANT_CONFIG_DIR/firewall.meshbak" "$MESHASSISTANT_CONFIG_DIR/firewall"

        # Put back only the services this mode disabled; a service the
        # administrator had disabled before entering Dumb AP stays off.
        restore_services

        # Dumb AP mode is over; the next enable must take a fresh snapshot.
        uci -q del meshassistant.config.ap_mode_enabled
        uci_commit meshassistant

        # Reload all the system configs
        reload_config
        /etc/init.d/network reload
        wifi reload
    else
        echo "Unable to restore configs as none were found."
    fi
}

# Remove mesh wireless sections that belong to a mesh_id which is no longer
# used.  The optional second argument names one section to keep.
#
# enable_meshassistant() passes the 802.11s section of the selected radio when
# the mesh_id does not change.  Deleting and recreating that section detaches
# mesh_batman from its wireless device; netifd then reports the interface as
# "no device", which LuCI shows as "Device: nonexistent".  setup_mesh_radio()
# overwrites every option of the kept section anyway.
clear_by_mesh_id() {
    # Passed mesh_id to clear, allows us to multipurpose this function
    MESH_ID_TO_CLEAR=$1
    local keep_section="$2"

    # Get the radio to be used for mesh from the config
    AP_RADIO=$(uci -q get meshassistant.config.apRadio)

    # Check if MESH_NAME is not empty
    if [ -z "$MESH_ID_TO_CLEAR" ]; then
        echo "No mesh_id passed to remove from wireless."
        return;
    fi

    # Get the output from uci show wireless
    uci_output=$(uci show wireless)

    # Find mesh sections with the matching mesh_id and delete them.  The
    # script stores the SSID with a "-mesh" suffix, so match both the current
    # suffixed value and the unsuffixed value used by older versions.
    mesh_sections=$(printf '%s\n' "$uci_output" \
        | grep -E '^wireless\.mesh_radio[0-9]+\.mesh_id=' \
        | grep -F -e "mesh_id='${MESH_ID_TO_CLEAR}-mesh'" -e "mesh_id='${MESH_ID_TO_CLEAR}'" \
        | cut -d. -f2 | sort -u)
    for section in $mesh_sections; do
        if [ -n "$keep_section" ] && [ "$section" = "$keep_section" ]; then
            echo "Keeping mesh network '$section' for reconfiguration."
            continue
        fi
        uci -q del "wireless.$section"
        echo "Deleted mesh network '$section' with mesh_id '$MESH_ID_TO_CLEAR'."
    done

    # Older versions of this plugin stored the 802.11s backhaul in wifinetN.
    # Remove such a section only when it is actually bound to mesh_batman and
    # carries the mesh SSID.  A regular AP with the same SSID must never be
    # deleted: it is not part of the mesh backhaul.
    legacy_sections=$(printf '%s\n' "$uci_output" \
        | grep -E '^wireless\.wifinet[0-9]+\.network=' \
        | grep -F 'mesh_batman' \
        | cut -d. -f2 | sort -u)
    for section in $legacy_sections; do
        if [ -n "$keep_section" ] && [ "$section" = "$keep_section" ]; then
            continue
        fi
        legacy_ssid=$(uci -q get "wireless.$section.ssid")
        case "$legacy_ssid" in
            "$MESH_ID_TO_CLEAR"|"$MESH_ID_TO_CLEAR-mesh")
                uci -q del "wireless.$section"
                echo "Deleted legacy mesh wireless network '$section' with ssid '$legacy_ssid'."
                ;;
            *)
                echo "Keeping wireless '$section': it is not a mesh backhaul for '$MESH_ID_TO_CLEAR'."
                ;;
        esac
    done

    # Commit changes to make sure the wireless configuration is updated.
    # The caller applies network and wireless once at the end (see
    # apply_mesh_config); reloading here would briefly remove the wireless
    # device that mesh_batman depends on.
    uci_commit wireless
}

create_batman_network() {
    echo "Setting up Batman network..."

    # Ensure bat0 exists
    if uci -q get network.bat0 >/dev/null; then
        echo "bat0 interface already exists."
    else
        uci set network.bat0=interface
        uci set network.bat0.proto='batadv'
        uci set network.bat0.routing_algo='BATMAN_V'
        uci set network.bat0.aggregated_ogms='1'
        uci set network.bat0.ap_isolation='0'
        uci set network.bat0.bonding='1'
        uci set network.bat0.bridge_loop_avoidance='1'
        uci set network.bat0.distributed_arp_table='1'
        uci set network.bat0.fragmentation='1'
        uci set network.bat0.hop_penalty='30'
        uci set network.bat0.isolation_mark='0x00000000/0x00000000'
        uci set network.bat0.log_level='0'
        uci set network.bat0.multicast_fanout='16'
        uci set network.bat0.multicast_mode='1'
        uci set network.bat0.network_coding='0'
        uci set network.bat0.orig_interval='1000'
        echo "bat0 interface has been created."
    fi

    # Set the bat0 role.  LuCI omits options that equal their form default, so
    # a device configured with the default "Server" role has no role option at
    # all; treat an empty value as server.
    BAT_ROLE=$(uci -q get meshassistant.config.role)
    [ -z "$BAT_ROLE" ] && BAT_ROLE=server
    if [ "${BAT_ROLE}" == "server" ]; then
        uci set network.bat0.gw_mode='server'
        echo "Setting bat0 as a server."

        # A server must not keep the LAN address and hostname that a previous
        # node run applied.
        restore_node_lan_state
        restore_hostname_state

        # Ensure bat0 is part of the LAN bridge.  Do not remove
        # mesh_batman.master: that option points the hardif at bat0 and is
        # required for the 802.11s mesh device to join the batman-adv mesh.
        bridge_add_port bat0

        # Firewall: add bat0 to the LAN zone and remove the layer-2 hardif
        # from every zone.  Find zones by name instead of by index so that a
        # reordered firewall config is not damaged.
        if ! firewall_zone_has_network lan bat0; then
            uci set meshassistant.config.lan_zone_bat0_added=1
        fi
        firewall_zone_add_network lan bat0
        firewall_remove_network_everywhere mesh_batman

        local server_dhcp wan_section wan_networks
        server_dhcp=$(uci -q get meshassistant.config.server_dhcp)
        [ -z "$server_dhcp" ] && server_dhcp=1

        # The WAN zone may carry wwan (a WiFi STA), wan or a custom uplink.
        # Never rewrite its network list: only add "wan" when it is empty, so
        # an existing wwan/custom uplink keeps working.
        wan_section=$(firewall_zone_section wan)
        if [ -z "$wan_section" ]; then
            echo "Warning: no firewall zone named 'wan'; internet access may need manual configuration."
        else
            wan_networks=$(uci -q get "firewall.$wan_section.network")
            if [ -z "$wan_networks" ]; then
                uci add_list "firewall.$wan_section.network=wan"
                echo "Added 'wan' to firewall zone 'wan'."
            fi
            if [ "$(uci -q get "firewall.$wan_section.masq")" != 1 ]; then
                uci set "firewall.$wan_section.masq=1"
                echo "Enabled NAT on firewall zone 'wan'."
            fi
            ensure_lan_wan_forwarding
        fi
        uci_commit firewall

        # Restore the firewall service if a previous node run disabled it.
        restore_service_if_disabled firewall

        if [ "$server_dhcp" = 1 ]; then
            restore_service_if_disabled dnsmasq
            restore_service_if_disabled odhcpd
            restore_dhcp_lan_state
        else
            save_dhcp_lan_state
            if uci -q get dhcp.lan >/dev/null; then
                uci set dhcp.lan.ignore='1'
                uci set dhcp.lan.ra='disabled'
                uci set dhcp.lan.dhcpv6='disabled'
                uci_commit dhcp
            fi
            # dnsmasq still serves DNS for the LAN; only DHCP/RA are off.
            restore_service_if_disabled dnsmasq
            disable_service_recorded odhcpd
            echo "Server does not provide DHCP; DHCP and IPv6 RA are disabled for the LAN."
        fi

    elif [ "${BAT_ROLE}" == "client" ] || [ "${BAT_ROLE}" == "off" ]; then
        uci set network.bat0.gw_mode='off'
        echo "Disabling bat0 gateway mode."

        # A node bridges bat0 into its LAN.  Do not add the wan port: a node
        # must not loop its uplink into the LAN.  Wired backhaul should use a
        # LAN port.
        bridge_add_port bat0

        # Nodes do not provide DHCP, DNS or a firewall.  Record which services
        # were enabled so that disabling the mesh or switching back to server
        # restores them.  Firewall zones are left untouched: deleting them
        # would lose the device's original firewall configuration.
        for service in firewall dnsmasq odhcpd; do
            disable_service_recorded "$service"
        done

        # Use the AP Mode tab settings (IP Mode, static address, gateway,
        # netmask, DNS and hostname) on every normal enable, not only in
        # Dumb AP mode.  The original values are restored on disable.
        apply_node_lan
    fi

    # Always enforce the hardif configuration.  Do not skip this when the
    # section already exists: an earlier version removed `master` on server
    # reapply, and a leftover section from a previous run would otherwise
    # stay broken and show up in LuCI as "Device: nonexistent".
    #
    # No `device` is intentional for 802.11s: the wireless mesh interface is
    # assigned to this network and netifd passes its real interface name to
    # the batadv_hardif protocol.
    if uci -q get network.mesh_batman.device >/dev/null; then
        uci -q del network.mesh_batman.device
        echo "Removed device assignment from mesh_batman to keep it unspecified."
    fi

    uci set network.mesh_batman=interface
    uci set network.mesh_batman.proto='batadv_hardif'
    uci set network.mesh_batman.master='bat0'
    uci set network.mesh_batman.mtu='1536'
    echo "Configured mesh_batman interface."

    # Attach the optional wired backhaul port to bat0.  This is done for
    # servers, nodes and clients alike: both ends of the cable must have the
    # same kind of hardif for the wired link to become a batman-adv neighbor.
    apply_wired_backhaul

    # Commit network and the recorded restore state.  The reload is deferred
    # to apply_mesh_config(): netifd then reads the new network and wireless
    # configuration together instead of applying the network half before the
    # 802.11s interface exists.
    uci_commit network
    uci_commit meshassistant

    echo "Network settings updated."
}

process_radios() {
    local rc=0

    # Get the radio to be used for mesh from the config
    AP_RADIO=$(uci -q get meshassistant.config.apRadio)

    # Check if AP_RADIO is empty, if so exit
    if [ -z "$AP_RADIO" ]; then
        echo "No radio specified in the config, exiting."
        exit 1
    fi

    # The regular AP sections are shared by all mesh radios, so create them
    # once instead of repeating the work for every mesh radio below.
    setup_ap_radios

    # Loop through the selected radios
    for CURRENT_RADIO in $AP_RADIO; do
        echo "Setting up mesh networks for: $CURRENT_RADIO"
        setup_mesh_radio "$CURRENT_RADIO" || rc=1
    done

    return "$rc"
}

# 802.11v (BSS Transition Management) is compiled into hostapd only with
# CONFIG_WNM_AP.  The full wpad builds and the wpad-mesh variants have it;
# wpad-basic, wpad-mini and hostapd-mini do not.  The basic builds still
# contain substrings such as bss_transition_request_tx, so compare whole
# NUL-terminated strings instead of a substring.
wnm_supported() {
    if [ -n "${MESHASSISTANT_WNM_OK:-}" ]; then
        [ "$MESHASSISTANT_WNM_OK" = 1 ]
        return
    fi

    MESHASSISTANT_WNM_OK=0
    local bin
    for bin in /usr/sbin/wpad /usr/sbin/hostapd; do
        [ -f "$bin" ] || continue
        if tr '\0' '\n' <"$bin" 2>/dev/null | grep -qx 'bss_transition'; then
            MESHASSISTANT_WNM_OK=1
            break
        fi
    done

    [ "$MESHASSISTANT_WNM_OK" = 1 ]
}

# Read-only report for the status page.  It runs the same wpad probe as an
# apply, so the hint the page shows matches what enabling client roaming would
# actually do: kvr is the roaming switch, wnm whether the installed wpad build
# has 802.11v, dawn whether DAWN is installed, dawn_running whether its procd
# instance is up, dawn_restarts how often procd has respawned it (omitted when
# procd cannot report the count).
capabilities() {
    local kvr=0 wnm=0 dawn=0 dawn_running=0 restarts=""

    [ "$(uci -q get meshassistant.config.kvr)" = 1 ] && kvr=1
    wnm_supported && wnm=1
    if [ -x /etc/init.d/dawn ]; then
        dawn=1
        # An installed but stopped service steers nothing, so the status
        # page has to see that state.  The procd respawn count travels with
        # it: a DAWN that crashes keeps looking "running" between respawns,
        # and only a rising count reveals the loop.
        if /etc/init.d/dawn status >/dev/null 2>&1; then
            dawn_running=1
            restarts=$(ubus call service list '{"name":"dawn"}' 2>/dev/null |
                jsonfilter -e '@.dawn.instances.instance1.respawn_count' 2>/dev/null)
        fi
    fi

    printf 'kvr=%s\nwnm=%s\ndawn=%s\ndawn_running=%s\n' \
        "$kvr" "$wnm" "$dawn" "$dawn_running"
    if [ -n "$restarts" ]; then
        printf 'dawn_restarts=%s\n' "$restarts"
    fi

    return 0
}

# Write the settings shared by every regular WiFi AP.  $1 is the UCI section
# name, $2 the wireless device (or device list) it serves and $3 the optional
# SSID for this section (defaults to the shared WIFI_ID).
configure_ap_iface() {
    local section="$1" device="$2" ssid="${3:-$WIFI_ID}"

    uci set wireless.$section='wifi-iface'
    uci set wireless.$section.device="$device"
    uci set wireless.$section.mode='ap'
    uci set wireless.$section.ssid="$ssid"
    uci set wireless.$section.network='lan'
    uci set wireless.$section.ieee80211r='1'
    uci set wireless.$section.mobility_domain="$MOBILITY_DOMAIN"
    uci set wireless.$section.ft_over_ds='0'
    uci set wireless.$section.ft_psk_generate_local='0'
    uci set wireless.$section.disabled='0'

    # 802.11k/v are only useful for steering, so they follow the roaming
    # switch.  hostapd refuses to start on an option it was not compiled
    # with, which would take the whole radio down, so bss_transition is only
    # written after the installed wpad build proved it supports 802.11v.
    if [ "${KVR_ENABLED:-0}" = 1 ]; then
        uci set wireless.$section.ieee80211k='1'
        if wnm_supported; then
            uci set wireless.$section.bss_transition='1'
        else
            uci -q delete wireless.$section.bss_transition
        fi
    else
        uci -q delete wireless.$section.ieee80211k
        uci -q delete wireless.$section.bss_transition
    fi

    # Apply encryption settings for regular WiFi
    if [ "$ENCRYPTION_ENABLED" = 1 ] && [ -n "$NETWORK_KEY" ]; then
        uci set wireless.$section.encryption='sae-mixed'
        uci set wireless.$section.key="$NETWORK_KEY"
    else
        uci set wireless.$section.encryption='none'
        [ -z "$NETWORK_KEY" ] && echo "Encryption key is empty, so encryption was disabled."
    fi
}

# Every link of an AP MLD must be 802.11be; otherwise hostapd refuses the link
# with "Cannot enable mld_ap when IEEE 802.11be is disabled".  Keep the
# configured channel width and switch the radio to its EHT equivalent.
enable_eht_htmode() {
    local radio="$1" htmode width

    htmode=$(uci -q get wireless.$radio.htmode)
    case "$htmode" in
        EHT*) return 0 ;;
    esac

    width=${htmode#HE}
    width=${width#VHT}
    width=${width#HT}
    case "$width" in
        20|40|80|160|320) ;;
        *) width=20 ;;
    esac

    uci set wireless.$radio.htmode="EHT$width"
    echo "Set $radio htmode to EHT$width for MLO."
}

# Return success when a mode/width pair is valid for the radio's band.  The
# form only offers valid combinations, but the config can also be edited by
# hand, so the script checks again before handing it to hostapd.
valid_spectrum_htmode() {
    local band="$1" mode="$2" width="$3"

    case "$mode" in
        HT)
            case "$width" in 20|40) return 0 ;; esac
            ;;
        VHT)
            case "$band:$width" in
                5g:20|5g:40|5g:80|5g:160) return 0 ;;
            esac
            ;;
        HE)
            case "$width" in 20|40|80|160) return 0 ;; esac
            ;;
        EHT)
            case "$width" in
                20|40|80|160) return 0 ;;
                320) [ "$band" = "6g" ] && return 0 ;;
            esac
            ;;
    esac

    return 1
}

# Apply the per-radio spectrum settings saved by the "Spectrum Settings" tab.
# Empty values are skipped, so a field the user did not set never overrides the
# radio's current configuration or the driver default.  The settings live in
# meshassistant.config rather than wireless so a reapply can reapply them after
# the AP/mesh sections are regenerated.
apply_spectrum_settings() {
    local radio radio_list seen band country channel mode width txpower
    local current htmode effective_channel

    radio_list="$AP_RADIO $(uci -q get meshassistant.config.wifi_radio)"
    seen=""

    for radio in $radio_list; do
        [ -n "$radio" ] || continue
        case " $seen " in
            *" $radio "*) continue ;;
        esac
        seen="$seen $radio"

        band=$(uci -q get wireless.$radio.band)
        country=$(uci -q get meshassistant.config.spectrum_${radio}_country)
        channel=$(uci -q get meshassistant.config.spectrum_${radio}_channel)
        mode=$(uci -q get meshassistant.config.spectrum_${radio}_mode)
        width=$(uci -q get meshassistant.config.spectrum_${radio}_width)
        txpower=$(uci -q get meshassistant.config.spectrum_${radio}_txpower)

        if [ -n "$country" ]; then
            case "$country" in
                [A-Z0-9][A-Z0-9])
                    uci set wireless.$radio.country="$country"
                    echo "Spectrum: $radio country=$country"
                    ;;
                *)
                    echo "Spectrum: ignoring invalid country '$country' for $radio."
                    ;;
            esac
        fi

        if [ -n "$channel" ]; then
            case "$channel" in
                auto)
                    uci set wireless.$radio.channel='auto'
                    echo "Spectrum: $radio channel=auto"
                    ;;
                *[!0-9]*)
                    echo "Spectrum: ignoring invalid channel '$channel' for $radio."
                    ;;
                *)
                    uci set wireless.$radio.channel="$channel"
                    echo "Spectrum: $radio channel=$channel"
                    ;;
            esac
        fi

        if [ -n "$mode" ] || [ -n "$width" ]; then
            current=$(uci -q get wireless.$radio.htmode)

            if [ -z "$mode" ]; then
                case "$current" in
                    EHT*) mode='EHT' ;;
                    HE*) mode='HE' ;;
                    VHT*) mode='VHT' ;;
                    HT*) mode='HT' ;;
                    *) mode='' ;;
                esac
            fi

            if [ -z "$width" ]; then
                width=${current#EHT}
                width=${width#HE}
                width=${width#VHT}
                width=${width#HT}
                case "$width" in
                    20|40|80|160|320) ;;
                    *) width=20 ;;
                esac
            fi

            if [ -n "$mode" ] && valid_spectrum_htmode "$band" "$mode" "$width"; then
                htmode="$mode$width"
                uci set wireless.$radio.htmode="$htmode"
                echo "Spectrum: $radio htmode=$htmode"
            else
                echo "Spectrum: ignoring invalid PHY mode/width '${mode}${width}' for $radio ($band)."
            fi
        fi

        if [ -n "$txpower" ]; then
            case "$txpower" in
                *[!0-9]*)
                    echo "Spectrum: ignoring invalid transmit power '$txpower' for $radio."
                    ;;
                *)
                    if [ "$txpower" -ge 1 ] && [ "$txpower" -le 40 ]; then
                        uci set wireless.$radio.txpower="$txpower"
                        echo "Spectrum: $radio txpower=${txpower} dBm"
                    else
                        echo "Spectrum: ignoring out-of-range transmit power '$txpower' for $radio."
                    fi
                    ;;
            esac
        fi

        # hostapd accepts a 5 GHz MLO link on a DFS channel, but radar
        # detection can interrupt it.  Keep the user's choice and warn.
        effective_channel=$(uci -q get wireless.$radio.channel)
        if [ "$(uci -q get meshassistant.config.mlo)" = 1 ] && [ "$band" = "5g" ]; then
            case " $(uci -q get meshassistant.config.wifi_radio) " in
                *" $radio "*)
                    case "$effective_channel" in
                        52|56|60|64|100|104|108|112|116|120|124|128|132|136|140|144)
                            echo "Spectrum: warning: $radio uses DFS channel $effective_channel; an MLO link may be interrupted by radar detection."
                            ;;
                    esac
                    ;;
            esac
        fi
    done

    uci_commit wireless
}

# Configure the regular WiFi AP.  Without MLO one AP is created per selected
# radio.  With MLO the two selected radios form a single AP MLD, so clients see
# one WiFi 7 access point reachable over both links.  Every radio uses the same
# key and KVR settings; the SSID is shared unless ssid_mode is 'separate'.
setup_ap_radios() {
    local radio managed count=0 radio_ssid configured_ssid mobility_seed

    WIFI_ID=$(uci -q get meshassistant.config.wifi_id)
    WIFI_RADIOS=$(uci -q get meshassistant.config.wifi_radio)
    ENCRYPTION_ENABLED=$(uci -q get meshassistant.config.encryption)
    NETWORK_KEY=$(uci -q get meshassistant.config.key)
    MOBILITY_DOMAIN=$(uci -q get meshassistant.config.mobility_domain)
    KVR_ENABLED=$(uci -q get meshassistant.config.kvr)
    [ -n "$KVR_ENABLED" ] || KVR_ENABLED=0
    MLO_ENABLED=$(uci -q get meshassistant.config.mlo)
    SSID_MODE=$(uci -q get meshassistant.config.ssid_mode)
    [ -z "$SSID_MODE" ] && SSID_MODE='same'

    if [ -z "$WIFI_ID" ]; then
        echo "Regular WiFi SSID is empty. Using default."
        WIFI_ID="meshassistant_AC"
    fi

    # Every AP in the mesh must use the same mobility domain for 802.11r.
    # The form always saves one; when the option is missing (an old config,
    # or the script run directly) derive it from the Mesh SSID instead of
    # picking a random value that differs on every device.
    if [ -z "$MOBILITY_DOMAIN" ]; then
        mobility_seed=$(uci -q get meshassistant.config.mesh_id)
        [ -n "$mobility_seed" ] || mobility_seed="$WIFI_ID"
        MOBILITY_DOMAIN=$(printf '%s' "$mobility_seed" | cksum | awk '{ printf "%04x", $1 % 65536 }')
        uci set meshassistant.config.mobility_domain="$MOBILITY_DOMAIN"
        echo "Mobility domain derived from the Mesh SSID: $MOBILITY_DOMAIN"
    fi

    for radio in $WIFI_RADIOS; do
        count=$((count + 1))
    done

    # MLO combines exactly two radios into one access point.  Ignore a saved
    # flag for any other selection, so a later change to one radio cannot
    # leave a half-configured MLD behind.
    if [ "$MLO_ENABLED" = 1 ] && [ "$count" -eq 2 ]; then
        echo "Configuring one MLO access point on $WIFI_RADIOS (SSID '$WIFI_ID')"

        for radio in $WIFI_RADIOS; do
            enable_eht_htmode "$radio"
        done

        configure_ap_iface wifi_ap_mlo "$WIFI_RADIOS"
        uci set wireless.wifi_ap_mlo.mlo='1'

        # The single MLD interface replaces the per-radio AP sections.
        for radio in $WIFI_RADIOS; do
            if [ "$(uci -q get wireless.wifi_ap_$radio.mode)" = "ap" ]; then
                uci -q del "wireless.wifi_ap_$radio"
                echo "Deleted regular WiFi AP '$radio' merged into MLO."
            fi
        done
    else
        # Drop an MLO access point left by an earlier run.
        if [ "$(uci -q get wireless.wifi_ap_mlo.mlo)" = 1 ]; then
            uci -q del wireless.wifi_ap_mlo
            echo "Deleted the MLO access point."
        fi

        for radio in $WIFI_RADIOS; do
            radio_ssid="$WIFI_ID"
            configured_ssid=""

            if [ "$SSID_MODE" = "separate" ]; then
                configured_ssid=$(uci -q get "meshassistant.config.wifi_id_$radio")
                if [ -n "$configured_ssid" ]; then
                    radio_ssid="$configured_ssid"
                fi

                echo "SSID mode: separate, $radio uses '$radio_ssid'."
            fi

            echo "Configuring regular WiFi AP on $radio (SSID '$radio_ssid')"
            configure_ap_iface "wifi_ap_$radio" "$radio" "$radio_ssid"
        done
    fi

    # Remove AP sections that this plugin managed on an earlier run but that
    # are no longer selected.  Only radios recorded in ap_radios_managed are
    # considered, so a user-created wifi_ap_* section is never deleted.
    managed=$(uci -q get meshassistant.config.ap_radios_managed)
    for radio in $managed; do
        case " $WIFI_RADIOS " in
            *" $radio "*) continue ;;
        esac
        if [ "$(uci -q get wireless.wifi_ap_$radio.mode)" = "ap" ]; then
            uci -q del "wireless.wifi_ap_$radio"
            echo "Deleted stale regular WiFi AP '$radio'."
        fi
    done

    # Remember exactly which radios are managed by this plugin.
    uci -q del meshassistant.config.ap_radios_managed
    for radio in $WIFI_RADIOS; do
        uci add_list meshassistant.config.ap_radios_managed="$radio"
    done

    uci_commit meshassistant
    uci_commit wireless
}

# This is called from the process_radios function and is passed the radio to be used for mesh
setup_mesh_radio() {
    echo "Setting up mesh network"

    local CURRENT_RADIO="$1"

    # Get the mesh name from the config
    MESH_ID=$(uci -q get meshassistant.config.mesh_id)

    if [ -z "$MESH_ID" ]; then
        echo "Error: Mesh SSID is empty. Cannot configure mesh."
        return 1
    fi
    if [ -z "$CURRENT_RADIO" ]; then
        echo "Error: Mesh radio is empty. Cannot configure mesh."
        return 1
    fi

    # Generate Mesh AP SSID by appending '-mesh'
    MESH_SSID="${MESH_ID}-mesh"

    echo "Mesh SSID: $MESH_SSID on $CURRENT_RADIO"

    # Get encryption settings
    ENCRYPTION_ENABLED=$(uci -q get meshassistant.config.encryption)
    NETWORK_KEY=$(uci -q get meshassistant.config.key)

    ###### Mesh AP Configuration ######
    if [ ! -z "$CURRENT_RADIO" ]; then
        echo "Configuring Mesh AP on $CURRENT_RADIO"

        uci set wireless.mesh_$CURRENT_RADIO='wifi-iface'
        uci set wireless.mesh_$CURRENT_RADIO.device="$CURRENT_RADIO"
        uci set wireless.mesh_$CURRENT_RADIO.ifname="mesh_$CURRENT_RADIO"
        uci set wireless.mesh_$CURRENT_RADIO.network='mesh_batman'
        uci set wireless.mesh_$CURRENT_RADIO.mode='mesh'
        uci set wireless.mesh_$CURRENT_RADIO.mesh_id="$MESH_SSID"
        uci set wireless.mesh_$CURRENT_RADIO.mesh_fwding='0'
        uci set wireless.mesh_$CURRENT_RADIO.mesh_rssi_threshold='0'
        uci set wireless.mesh_$CURRENT_RADIO.mesh_ttl='1'
        uci set wireless.mesh_$CURRENT_RADIO.mcast_rate='24000'
        uci set wireless.mesh_$CURRENT_RADIO.disabled='0'  # ?? Force-enable mesh AP

        # Apply encryption settings for mesh.  The key is a single uci
        # argument, so it has to stay quoted: a passphrase may contain spaces
        # and word splitting would store a truncated key while the section is
        # committed as encrypted.
        if [ "$ENCRYPTION_ENABLED" = 1 ] && [ ! -z "$NETWORK_KEY" ]; then
            uci set wireless.mesh_$CURRENT_RADIO.encryption='sae'
            if ! uci set "wireless.mesh_$CURRENT_RADIO.key=$NETWORK_KEY"; then
                echo "Error: unable to store the mesh password; the mesh AP was not configured."
                return 1
            fi
        else
            uci set wireless.mesh_$CURRENT_RADIO.encryption='none'
        fi

        uci_commit wireless
    fi
}

# Give the DAWN configuration back to the state found before the plugin
# managed it: stop and disable the service, restore the saved /etc/config/dawn
# (or remove the generated one when there was no original), and drop the
# marker.  With no marker this is a no-op.
dawn_release() {
    [ -f "$DAWN_MANAGED" ] || return 0

    /etc/init.d/dawn stop >/dev/null 2>&1
    /etc/init.d/dawn disable >/dev/null 2>&1

    if [ -f "$DAWN_BACKUP" ]; then
        cp "$DAWN_BACKUP" "$DAWN_CONFIG"
        rm -f "$DAWN_BACKUP"
    else
        rm -f "$DAWN_CONFIG"
    fi

    rm -f "$DAWN_MANAGED"
    log_note "Stopped and disabled DAWN; client roaming is off."
}

# Write the DAWN configuration from the form values while roaming is enabled.
#
# DAWN is a hard dependency and the package manager enables and starts it on
# installation, so left alone it runs the upstream defaults (kicking=3,
# -60/-80 dBm) and can move clients while the plugin's own thresholds are not
# in effect.  This function makes the running service match the form.  The
# first pre-existing configuration is kept aside for dawn_release().
setup_dawn() {
    local kvr rssi low secret shared band

    kvr=$(uci -q get meshassistant.config.kvr)
    [ -n "$kvr" ] || kvr=0

    if [ "$kvr" != 1 ] || [ "$(uci -q get meshassistant.config.enabled)" != 1 ]; then
        dawn_release
        return 0
    fi

    if ! wnm_supported; then
        dawn_release
        log_note "Warning: the installed wpad build has no 802.11v support, so DAWN was left stopped. Install wpad-mbedtls, wpad-openssl, wpad-wolfssl or a wpad-mesh variant to enable client steering."
        return 0
    fi

    if [ ! -x /etc/init.d/dawn ]; then
        log_note "Warning: DAWN is not installed, so client steering is unavailable."
        return 0
    fi

    rssi=$(uci -q get meshassistant.config.rssi_val)
    [ -n "$rssi" ] || rssi='-60'
    low=$(uci -q get meshassistant.config.low_rssi_val)
    [ -n "$low" ] || low='-88'

    if [ ! -f "$DAWN_MANAGED" ] && [ ! -f "$DAWN_BACKUP" ] && [ -f "$DAWN_CONFIG" ]; then
        cp "$DAWN_CONFIG" "$DAWN_BACKUP"
    fi

    # DAWN looks the global metric section up by the name "global" and the
    # band sections by "802_11g"/"802_11a"; a config that lacks them (for
    # example after a release removed the file) gets the named sections back.
    [ -n "$(uci -q get dawn.global)" ] || uci set dawn.global='metric'
    [ -n "$(uci -q get dawn.802_11g)" ] || uci set dawn.802_11g='metric'
    [ -n "$(uci -q get dawn.802_11a)" ] || uci set dawn.802_11a='metric'

    # The network section is different: DAWN takes the first "config network"
    # section whether it is named or anonymous, and the stock file ships an
    # anonymous one.  Address it by type so the key lands where DAWN reads it
    # instead of in a second section it would ignore.
    [ -n "$(uci -q get dawn.@network[0])" ] || uci add dawn network >/dev/null

    secret=$(uci -q get meshassistant.config.key)
    [ -n "$secret" ] || secret=$(uci -q get meshassistant.config.mesh_id)
    shared=$(printf 'meshassistant:%s' "$secret" | md5sum | cut -c1-32)

    # kicking=3 evaluates both the RSSI score and the absolute RSSI;
    # kicking_threshold and min_number_to_kick keep one stray sample from
    # moving a client.  set_hostapd_nr=1 publishes every AP in the mesh as a
    # neighbor report.  The absolute check compares against rssi_center, so
    # the form's Bad RSSI value is written there as well, not only to
    # low_rssi_val which scores the connection.  duration is the 802.11k
    # measurement time and the BTM disassociation/validity window in
    # milliseconds; the stock file ships zero, which leaves the request
    # without a validity window, so write the daemon's own default.
    uci set dawn.global.kicking='3'
    uci set dawn.global.kicking_threshold='20'
    uci set dawn.global.min_number_to_kick='3'
    uci set dawn.global.set_hostapd_nr='1'
    uci set dawn.global.duration='150'
    for band in 802_11g 802_11a; do
        uci set dawn.$band.rssi_val="$rssi"
        uci set dawn.$band.low_rssi_val="$low"
        uci set dawn.$band.rssi_center="$low"
    done
    uci set dawn.@network[0].shared_key="$shared"

    touch "$DAWN_MANAGED"
    uci_commit dawn

    log_note "Running: /etc/init.d/dawn enable; /etc/init.d/dawn restart"
    /etc/init.d/dawn enable >/dev/null 2>&1
    /etc/init.d/dawn restart >/dev/null 2>&1
    echo "Client roaming enabled (802.11k/v via DAWN: good $rssi dBm, bad $low dBm)."
}

# Apply the complete network and wireless configuration.
#
# This must stay non-destructive.  The script runs detached from LuCI, so the
# user usually opens Network -> Interfaces while it is still working.  An
# earlier version ran "/etc/init.d/network restart" and "wifi up" here; both
# tear every wireless interface down and rebuild it, which removes the 802.11s
# device that mesh_batman is bound to and makes LuCI report
# "Device: nonexistent" until the radios come back.
apply_mesh_config() {
    local radio radios

    # A mesh without a Mesh SSID has no wireless device for mesh_batman to
    # bind to; keep the network on its current state and report the failure
    # instead of printing "Mesh configuration applied.".
    if [ -z "$(uci -q get meshassistant.config.mesh_id)" ]; then
        echo "Error: Mesh SSID is empty. Cannot apply the mesh configuration."
        return 1
    fi

    AP_RADIO=$(uci -q get meshassistant.config.apRadio)

    # Check if AP_RADIO is empty, if so exit
    if [ -z "$AP_RADIO" ]; then
        echo "No radio specified in the config, exiting."
        exit 1
    fi

    # Enable the mesh radio and the regular AP radio.  They are usually two
    # different radios; enabling only apRadio left the AP radio disabled.
    radios="$AP_RADIO $(uci -q get meshassistant.config.wifi_radio)"
    for radio in $radios; do
        [ -n "$radio" ] || continue
        echo "Enabling $radio..."
        uci set wireless.$radio.disabled=0
    done

    uci_commit wireless

    # netifd reads /etc/config/network first, so bat0 and mesh_batman exist
    # before the 802.11s interface is created and attached to mesh_batman.
    # reload_config then applies the firewall, DHCP and system changes.
    log_note "Running: /etc/init.d/network reload"
    /etc/init.d/network reload
    log_note "Running: wifi reload"
    wifi reload
    log_note "Running: reload_config"
    reload_config

    # DAWN reads the hostapd BSS list, so it is (re)started only after the
    # wireless configuration above is live.
    log_note "Phase: configuring client roaming"
    setup_dawn

    # The AP Mode address is applied by the network reload above.  Verify it
    # before reporting success and roll it back when it did not come up.
    lan_watchdog_check

    echo "Mesh configuration applied."
}

disable_batman_interfaces() {
    # Return the wired backhaul port to the LAN bridge before bat0 goes away.
    remove_wired_backhaul

    # Delete the bat0 interface
    if [ "$(uci -q get network.bat0)" = "interface" ]; then
        uci -q del network.bat0
    fi

    # Delete the mesh_batman network interface
    if [ "$(uci -q get network.mesh_batman)" = "interface" ]; then
        uci -q del network.mesh_batman
    fi

    uci_commit network
    echo "Removed bat0 and mesh_batman from the network config."
}

# ---------------------------------------------------------------------------
# Peer identity service
#
# The neighbor MAC in "batctl n" is the remote mesh hardif address, while the
# LAN address belongs to br-lan.  In a shared wired segment BATMAN's global
# translation table stays empty, so the two cannot be correlated from the
# batman-adv tables alone.  Each device therefore announces its own hardif
# MAC(s), LAN address and hostname by UDP broadcast.  The broadcast is bridged
# onto bat0, so the nodes receive each other's announcement without knowing
# each other's address in advance.  The announcement also names the MAC of the
# LAN bridge: after the LAN address changed, that MAC can still be mapped to
# the abandoned address by the neighbour table, a stale DHCP lease or the DAT
# cache, and the receiver needs to know which addresses belong to the device
# itself.
# ---------------------------------------------------------------------------

# Ethernet device of the LAN interface, falling back to br-lan.
lan_device() {
    local dev
    dev=$(uci -q get network.lan.device)
    [ -z "$dev" ] && dev=$(uci -q get network.lan.ifname)
    dev=${dev%% *}
    [ -n "$dev" ] || dev=br-lan
    printf '%s\n' "$dev"
}

lan_ipv4() {
    local ip
    ip=$(ip -4 -o addr show dev "$(lan_device)" 2>/dev/null \
        | awk '{ for (i = 1; i <= NF; i++) if ($i == "inet") { print $(i + 1); exit } }')
    ip=${ip%%/*}
    case "$ip" in
        ''|*[!0-9.]*) return 0 ;;
    esac
    printf '%s\n' "$ip"
}

# Directed broadcast of the LAN, which bat0 bridges to the other mesh devices.
lan_broadcast() {
    ip -4 -o addr show dev "$(lan_device)" 2>/dev/null \
        | awk '{ for (i = 1; i <= NF; i++) if ($i == "brd") { print $(i + 1); exit } }'
}

# MAC of the LAN bridge.  The LAN address is attached to this address in the
# neighbour table, the DHCP leases and the DAT cache, so a receiver can use it
# to tell the addresses of the device itself apart from its clients' ones.
lan_hwaddr() {
    local mac
    mac=$(cat "/sys/class/net/$(lan_device)/address" 2>/dev/null | tr 'A-F' 'a-f')
    case "$mac" in
        [0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]) ;;
        *) mac='' ;;
    esac
    [ -n "$mac" ] || return 0
    printf '%s\n' "$mac"
}

# Addresses and medium of every batman-adv hardif.  A neighbor can be reached
# through the Mesh radio or through a wired backhaul port; "batctl n" reports
# the MAC of the hardif that carries the link, so all of them have to be
# announced.  "<iface> <MAC> <kind>" keeps the interface name, which the
# announcement needs to report that hardif's backhaul state, and the medium,
# which a receiver needs to label a hardif it is not a direct neighbor of.
mesh_hardif_bindings() {
    local iface mac kind
    for iface in $(batctl meshif bat0 interface 2>/dev/null \
            | sed -n 's/^\([^:]*\):.*/\1/p'); do
        [ -r "/sys/class/net/$iface/address" ] || continue
        mac=$(cat "/sys/class/net/$iface/address" 2>/dev/null)
        [ -n "$mac" ] || continue
        if hardif_is_wireless "$iface"; then
            kind=wlan
        else
            kind=wired
        fi
        printf '%s %s %s\n' "$iface" "$mac" "$kind"
    done
}

mesh_hardif_macs() {
    mesh_hardif_bindings | awk '{ print $2 }'
}


# Best direct link speed "batctl n" reports for each local hardif, in the unit
# batctl prints (Mbit/s).  batman measures the link itself, so the owning
# device is the only one that can rate a link no other device is an endpoint
# of; the announcement carries the value to the rest of the mesh.  A hardif
# without a direct neighbor has no measurable rate and is left out.
mesh_hardif_speeds() {
    batctl meshif bat0 neighbors 2>/dev/null | awk '
        $3 == "(" && NF >= 5 {
            iface = $NF
            gsub(/[^A-Za-z0-9_.@-]/, "", iface)
            speed = $4
            gsub(/[^0-9.]/, "", speed)
            if (iface != "" && speed ~ /^[0-9]+(\.[0-9]+)?$/)
                if (!(iface in best) || speed + 0 > best[iface] + 0)
                    best[iface] = speed
        }
        END {
            for (iface in best)
                print iface, best[iface]
        }'
}

# Names of the local hardifs that carry at least one selected originator.
# "batctl o" marks the candidate batman forwards through with "*"; the
# bracketed field at the end of that line names the local hardif.
mesh_selected_ifaces() {
    batctl meshif bat0 originators 2>/dev/null | awk '
        $1 == "*" && match($0, /\[[^]]*\]$/) {
            iface = substr($0, RSTART + 1, RLENGTH - 2)
            gsub(/^[ \t]+|[ \t]+$/, "", iface)
            if (iface != "")
                print iface
        }'
}

# Hostname and 1-minute load average, cleaned for the space-separated
# announcement and status lines.  "-" marks a value that could not be read.
local_hostname() {
    local hostname
    hostname=$(uci -q get system.@system[0].hostname)
    [ -n "$hostname" ] || hostname=$(cat /proc/sys/kernel/hostname 2>/dev/null)
    hostname=$(printf '%s' "$hostname" | tr -cd 'A-Za-z0-9._-')
    printf '%s\n' "${hostname:--}"
}

local_load() {
    local load
    load=$(cut -d' ' -f1 /proc/loadavg 2>/dev/null)
    case "$load" in
        ''|*[!0-9.]*|*.*.*) load='-' ;;
    esac
    printf '%s\n' "$load"
}

# The client names this device knows: the DHCP server's lease file plus the
# static host reservations of its dhcp config.  A reservation names a device
# that is often asleep and has no active lease, so the reservation lines come
# after the lease lines for the same MAC; the consumer stores every line and a
# later line replaces an earlier one, which lets the administrator's name win.
#   <MAC> <IPv4|-> <hostname>
local_names() {
    local section mac ip name

    if [ -r "$MESHASSISTANT_LEASES" ]; then
        while read -r _ mac ip name _; do
            [ -n "$mac" ] || continue
            [ "$name" = '*' ] && continue
            mac=${mac,,}
            name=$(printf '%s' "$name" | tr -cd 'A-Za-z0-9._-')
            [ -n "$name" ] || continue
            case "$ip" in
                ''|*[!0-9.]*) ip='-' ;;
            esac
            printf '%s %s %s\n' "$mac" "$ip" "$name"
        done < "$MESHASSISTANT_LEASES"
    fi

    uci -q show dhcp 2>/dev/null \
        | sed -n 's/^\(dhcp\.[^=]*\)=host$/\1/p' \
        | while read -r section; do
            [ -n "$section" ] || continue
            mac=$(uci -q get "$section.mac")
            mac=$(printf '%s' "$mac" | tr 'A-F' 'a-f')
            case "$mac" in
                [0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]) ;;
                *) continue ;;
            esac
            name=$(uci -q get "$section.name")
            name=$(printf '%s' "$name" | tr -cd 'A-Za-z0-9._-')
            [ -n "$name" ] || continue
            ip=$(uci -q get "$section.ip")
            case "$ip" in
                ''|*[!0-9.]*) ip='-' ;;
            esac
            printf '%s %s %s\n' "$mac" "$ip" "$name"
        done
}

announce_identity() {
    local ip brd hostname load mac lanmac selected speeds iface state speed
    ip=$(lan_ipv4)
    [ -n "$ip" ] || return 0

    brd=$(lan_broadcast)
    [ -n "$brd" ] || brd=255.255.255.255

    hostname=$(local_hostname)

    # Version 2 appends the 1-minute load average.  Older receivers drop
    # unknown versions, so they never mistake the extra field for a hostname.
    load=$(local_load)

    # Version 3 appends the LAN bridge MAC, which lets a receiver drop the
    # addresses its own tables still associate with an abandoned LAN address.
    # It is sent after the version 2 line in the same datagram: a receiver
    # that only reads the first line keeps working with the older format.
    lanmac=$(lan_hwaddr)

    # Version 4 appends the backhaul state of the announced hardif: "inuse"
    # when that hardif carries at least one selected originator, "standby"
    # when it does not and "-" when batman has no selected originator at all.
    # The state belongs to this device, so a receiver can label the remote
    # link with the state its own device reports instead of guessing from its
    # own originator table.
    #
    # Version 5 appends the medium of the announced hardif ("wlan" or "wired").
    # Together with the state it lets another device show a hardif it is not a
    # direct neighbor of, which "batctl n" alone never reveals.
    #
    # Version 6 appends the link speed "batctl n" measures on the announced
    # hardif (Mbit/s).  Only the device at one end of a link can measure it, so
    # a receiver that is not a direct neighbor of that hardif has no rate to
    # show unless the owning device announces it.  "-" means the hardif has no
    # direct neighbor right now.
    #
    # Version 7 appends the name of the announced hardif.  A receiver that is
    # not a direct neighbor of that hardif can otherwise show its medium, state
    # and rate but not the interface they belong to: "batctl n" only names the
    # receiving interface of a direct link.
    selected=$(mesh_selected_ifaces)
    speeds=$(mesh_hardif_speeds)

    mesh_hardif_bindings | while read -r iface mac kind; do
        [ -n "$mac" ] || continue

        state='-'
        if [ -n "$selected" ]; then
            if printf '%s\n' "$selected" | grep -qx "$iface"; then
                state='inuse'
            else
                state='standby'
            fi
        fi

        speed=$(printf '%s\n' "$speeds" \
            | awk -v i="$iface" '$1 == i { print $2; exit }')
        [ -n "$speed" ] || speed='-'

        {
            printf 'meshassistant/2 %s %s %s %s\n' "$mac" "$ip" "$hostname" "$load"
            [ -n "$lanmac" ] && \
                printf 'meshassistant/3 %s %s %s %s %s\n' \
                    "$mac" "$lanmac" "$ip" "$hostname" "$load"
            printf 'meshassistant/4 %s %s %s %s %s %s\n' \
                "$mac" "${lanmac:--}" "$ip" "$hostname" "$load" "$state"
            printf 'meshassistant/5 %s %s %s %s %s %s %s\n' \
                "$mac" "${lanmac:--}" "$ip" "$hostname" "$load" "$state" "${kind:--}"
            printf 'meshassistant/6 %s %s %s %s %s %s %s %s\n' \
                "$mac" "${lanmac:--}" "$ip" "$hostname" "$load" "$state" \
                "${kind:--}" "$speed"
            printf 'meshassistant/7 %s %s %s %s %s %s %s %s %s\n' \
                "$mac" "${lanmac:--}" "$ip" "$hostname" "$load" "$state" \
                "${kind:--}" "$speed" "$iface"
        } | socat -u - "UDP-DATAGRAM:$brd:$MESHASSISTANT_PORT,broadcast" 2>/dev/null
    done
}

# Broadcast the client names known to this device.  A receiving mesh device
# uses them for clients it cannot name itself; a device that has been quiet
# for a while has no ARP entry on that node and its lease exists only on the
# server, so a reverse lookup cannot name it either.  One datagram carries
# every named client:
#   meshassistant/8 <MAC> <IPv4|-> <hostname>
announce_names() {
    local brd lines

    lines=$(local_names)
    [ -n "$lines" ] || return 0

    brd=$(lan_broadcast)
    [ -n "$brd" ] || brd=255.255.255.255

    printf '%s\n' "$lines" \
        | sed 's/^/meshassistant\/8 /' \
        | socat -u - "UDP-DATAGRAM:$brd:$MESHASSISTANT_PORT,broadcast" 2>/dev/null
}

# Announcement file locking.
#
# socat starts one "peer" process per datagram and the daemon prunes the file
# while those processes append to it, so several processes write
# "$MESHASSISTANT_PEERS" at the same time.  Every write takes the same lock on
# fd 9, which the kernel releases when the writer closes the descriptor.  The
# client-name table "$MESHASSISTANT_NAMES" follows the same protocol with its
# own lock file; the two files are never locked at the same time, so both use
# descriptor 9.
#
#   peer_append   one complete line, one printf, lock held
#   prune_peers   the whole awk + rename rewrite, lock held
#   name_append   one complete line, one printf, lock held
#   prune_names   the whole awk + rename rewrite, lock held
#   daemon start  emptying the files, lock held
#
# With the rewrite excluded from the append window no announcement can land in
# a renamed-away inode, and with two appends excluded from each other no two
# lines can interleave.  flock comes from util-linux; when it is missing the
# writes still happen, only unserialized.
lock_peers() {
    flock -x 9 2>/dev/null || :
}

# Take the run lock for an operation that changes UCI, the network or the
# backups.  The descriptor stays open until the process exits, so a detached
# run keeps the lock for its whole lifetime; daemon, peer and linkinfo are
# read-only and do not call this.  Descriptor 8 is used because the peer
# helpers already own descriptor 9 for the announcement file.
take_run_lock() {
    mkdir -p "$(dirname "$MESHASSISTANT_LOCK")" 2>/dev/null
    exec 8>"$MESHASSISTANT_LOCK"
    if ! flock -n 8; then
        echo "Error: another Mesh Assistant operation is already running." >&2
        exit 1
    fi
}

peer_append() {
    {
        lock_peers
        printf '%s' "$1"$'\n' >>"$MESHASSISTANT_PEERS"
    } 9>>"$MESHASSISTANT_PEERS.lock"
}

lock_names() {
    flock -x 9 2>/dev/null || :
}

name_append() {
    {
        lock_names
        printf '%s' "$1"$'\n' >>"$MESHASSISTANT_NAMES"
    } 9>>"$MESHASSISTANT_NAMES.lock"
}

# Called by socat for every received datagram; the datagram is on stdin.  A
# datagram may carry several lines: the newer announcements follow the older
# ones so that receivers which only understand the older formats keep working.
# Each accepted line is stored as
# "<epoch> <mesh MAC> <IPv4|-> <hostname> <load|-> [<LAN MAC|->] [<state>]
# [<kind>] [<speed|->] [<iface|->]"; only a version 3 line and newer has the
# LAN MAC, only a version 4 line and newer has the state, only a version 5
# line and newer has the medium of the hardif, only a version 6 line has the
# link speed its device measures on that hardif and only a version 7 line has
# the hardif name.
#
# A version 8 line is a client name, not a peer identity: it is stored in
# "$MESHASSISTANT_NAMES" as "<epoch> <client MAC> <IPv4|-> <hostname>" and
# never in the peer file.  Older receivers ignore the version and simply
# cannot name clients they cannot reach themselves.
record_peer() {
    local proto rest mac lanmac ip hostname load state kind speed iface ts count
    while read -r proto rest || [ -n "$proto" ]; do
        mac=''
        lanmac=''
        ip=''
        hostname=''
        load=''
        state=''
        kind=''
        speed=''
        iface=''

        # Split the datagram without pathname expansion: its content comes
        # from the network and must not expand a glob.
        set -f
        set -- $rest
        set +f
        count=$#

        case "$proto" in
            meshassistant/1)
                [ "$count" -ge 3 ] || continue
                mac=$1 ip=$2 hostname=$3
                ;;
            meshassistant/2)
                [ "$count" -ge 4 ] || continue
                mac=$1 ip=$2 hostname=$3 load=$4
                ;;
            meshassistant/3)
                [ "$count" -ge 5 ] || continue
                mac=$1 lanmac=$2 ip=$3 hostname=$4 load=$5
                ;;
            meshassistant/4)
                [ "$count" -ge 6 ] || continue
                mac=$1 lanmac=$2 ip=$3 hostname=$4 load=$5 state=$6
                ;;
            meshassistant/5)
                [ "$count" -ge 7 ] || continue
                mac=$1 lanmac=$2 ip=$3 hostname=$4 load=$5 state=$6 kind=$7
                ;;
            meshassistant/6)
                [ "$count" -ge 8 ] || continue
                mac=$1 lanmac=$2 ip=$3 hostname=$4 load=$5 state=$6 kind=$7
                speed=$8
                ;;
            meshassistant/7)
                [ "$count" -ge 9 ] || continue
                mac=$1 lanmac=$2 ip=$3 hostname=$4 load=$5 state=$6 kind=$7
                speed=$8 iface=$9
                ;;
            meshassistant/8)
                [ "$count" -ge 3 ] || continue
                mac=$1 ip=$2 hostname=$3
                ;;
            *) continue ;;
        esac

        mac=$(printf '%s' "$mac" | tr 'A-F' 'a-f')
        case "$mac" in
            [0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]) ;;
            *) continue ;;
        esac

        if [ "$proto" = 'meshassistant/3' ] || [ "$proto" = 'meshassistant/4' ] \
                || [ "$proto" = 'meshassistant/5' ] \
                || [ "$proto" = 'meshassistant/6' ] \
                || [ "$proto" = 'meshassistant/7' ]; then
            lanmac=$(printf '%s' "$lanmac" | tr 'A-F' 'a-f')
            case "$lanmac" in
                [0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]) ;;
                *) lanmac='-' ;;
            esac
        fi

        if [ "$proto" = 'meshassistant/4' ] || [ "$proto" = 'meshassistant/5' ] \
                || [ "$proto" = 'meshassistant/6' ] \
                || [ "$proto" = 'meshassistant/7' ]; then
            case "$state" in
                inuse|standby) ;;
                *) state='-' ;;
            esac
        fi

        if [ "$proto" = 'meshassistant/5' ] || [ "$proto" = 'meshassistant/6' ] \
                || [ "$proto" = 'meshassistant/7' ]; then
            case "$kind" in
                wlan|wired) ;;
                *) kind='-' ;;
            esac
        fi

        if [ "$proto" = 'meshassistant/6' ] || [ "$proto" = 'meshassistant/7' ]; then
            case "$speed" in
                ''|*[!0-9.]*|*.*.*) speed='-' ;;
            esac
        fi

        # Interface names are at most IFNAMSIZ-1 bytes and use only these
        # characters; anything else is a hand-written or corrupt datagram.
        if [ "$proto" = 'meshassistant/7' ]; then
            case "$iface" in
                ''|*[!A-Za-z0-9_.@-]*) iface='-' ;;
            esac
            if [ "$iface" != '-' ] && [ "${#iface}" -gt 15 ]; then
                iface='-'
            fi
        fi

        [ "$ip" = "-" ] && ip=''
        case "$ip" in
            ''|*[!0-9.]*) ip='' ;;
        esac

        hostname=$(printf '%s' "$hostname" | tr -cd 'A-Za-z0-9._-')
        [ -n "$hostname" ] || hostname='-'

        load=$(printf '%s' "$load" | tr -cd '0-9.')
        case "$load" in
            ''|*.*.*) load='' ;;
        esac

        ts=$(date +%s)
        if [ "$proto" = 'meshassistant/8' ]; then
            name_append "$ts $mac ${ip:--} $hostname"
        elif [ "$proto" = 'meshassistant/7' ]; then
            peer_append "$ts $mac ${ip:--} $hostname ${load:--} $lanmac $state $kind $speed $iface"
        elif [ "$proto" = 'meshassistant/6' ]; then
            peer_append "$ts $mac ${ip:--} $hostname ${load:--} $lanmac $state $kind $speed"
        elif [ "$proto" = 'meshassistant/5' ]; then
            peer_append "$ts $mac ${ip:--} $hostname ${load:--} $lanmac $state $kind"
        elif [ "$proto" = 'meshassistant/4' ]; then
            peer_append "$ts $mac ${ip:--} $hostname ${load:--} $lanmac $state"
        elif [ "$proto" = 'meshassistant/3' ]; then
            peer_append "$ts $mac ${ip:--} $hostname ${load:--} $lanmac"
        else
            peer_append "$ts $mac ${ip:--} $hostname ${load:--}"
        fi
    done
}

# Drop announcements that were not refreshed within the maximum age.  The
# rewrite replaces the file, so it holds the peer lock: a line appended between
# awk reading the file and the rename would otherwise vanish with the old inode.
prune_peers() {
    local now tmp
    [ -f "$MESHASSISTANT_PEERS" ] || return 0
    now=$(date +%s)
    tmp="$MESHASSISTANT_PEERS.$$"
    {
        lock_peers
        # Stored timestamps are the receiver's own clock, so a value after
        # "now" can only come from a damaged line; without the upper bound
        # such a line would count as fresh forever.
        if awk -v now="$now" -v max="$MESHASSISTANT_PEER_MAX_AGE" \
                '($1 + 0) >= now - max && ($1 + 0) <= now' \
                "$MESHASSISTANT_PEERS" >"$tmp" 2>/dev/null; then
            mv "$tmp" "$MESHASSISTANT_PEERS"
        else
            rm -f "$tmp"
        fi
    } 9>>"$MESHASSISTANT_PEERS.lock"
}

# Same rewrite for the client-name table, under its own lock.
prune_names() {
    local now tmp
    [ -f "$MESHASSISTANT_NAMES" ] || return 0
    now=$(date +%s)
    tmp="$MESHASSISTANT_NAMES.$$"
    {
        lock_names
        if awk -v now="$now" -v max="$MESHASSISTANT_NAME_MAX_AGE" \
                '($1 + 0) >= now - max && ($1 + 0) <= now' \
                "$MESHASSISTANT_NAMES" >"$tmp" 2>/dev/null; then
            mv "$tmp" "$MESHASSISTANT_NAMES"
        else
            rm -f "$tmp"
        fi
    } 9>>"$MESHASSISTANT_NAMES.lock"
}

daemon_meshassistant() {
    local listener

    if ! command -v socat >/dev/null 2>&1; then
        echo "socat is not installed; peer announcements are disabled."
        exit 0
    fi

    {
        lock_peers
        : > "$MESHASSISTANT_PEERS"
    } 9>>"$MESHASSISTANT_PEERS.lock"
    {
        lock_names
        : > "$MESHASSISTANT_NAMES"
    } 9>>"$MESHASSISTANT_NAMES.lock"
    socat -u "UDP-RECVFROM:$MESHASSISTANT_PORT,reuseaddr,fork" \
        "EXEC:/etc/meshassistant/shell/meshassistant.sh peer" >/dev/null 2>&1 &
    listener=$!

    trap "kill $listener 2>/dev/null; rm -f '$MESHASSISTANT_PEERS' '$MESHASSISTANT_NAMES'; exit 0" INT TERM
    trap "kill $listener 2>/dev/null; rm -f '$MESHASSISTANT_PEERS' '$MESHASSISTANT_NAMES'" EXIT

    while true; do
        announce_identity
        announce_names
        prune_peers
        prune_names
        sleep "$MESHASSISTANT_ANNOUNCE_INTERVAL" &
        wait $!
    done
}

# A mac80211 netdev exposes a "phy80211" link in sysfs; an Ethernet port used
# for wired backhaul does not.
hardif_is_wireless() {
    [ -e "$MESHASSISTANT_SYS_CLASS_NET/$1/phy80211" ]
}

# Frequency, channel utilization and signal of the active mesh links.  "batctl
# n" only reports the MAC of the hardif that carries each link; the radio driver
# knows the channel, its busy time and the signal of each station.  Print one
# value per line so the LuCI view can merge it with the neighbor rows without
# parsing iw's multi-line output:
#   kind <hardif> wlan|wired
#   iface <hardif> <MHz> <channel> <width MHz>
#   busy <hardif> <percent>
#   peer <hardif> <MAC> <dBm>
# The channel and width are omitted when the driver does not report them.
# It also prints the identity of this device for the "Local Host" row:
#   local <hostname> <IPv4|-> <load|->
link_info() {
    local ip have_iw role kind mac
    # The status page must not report a mesh the user turned off as a read
    # error.  "running" is set when an apply succeeded and cleared by a
    # disable, so it describes the applied state, not just the saved form.
    if [ "$(uci -q get meshassistant.config.running)" = 1 ]; then
        printf 'state active=1\n'
    else
        printf 'state active=0\n'
    fi
    ip=$(lan_ipv4)
    # The status table labels this device with its effective role.  LuCI omits
    # the option when it equals the form default, so an empty value is the
    # same "server" default enable_meshassistant uses.
    role=$(uci -q get meshassistant.config.role)
    role=${role:-server}
    printf 'local %s %s %s %s\n' "$(local_hostname)" "${ip:--}" "$(local_load)" "$role"

    command -v iw >/dev/null 2>&1 && have_iw=1 || have_iw=0

    batctl meshif bat0 interface 2>/dev/null \
        | sed -n 's/^\([^:]*\):.*/\1/p' \
        | while read -r iface; do
            [ -n "$iface" ] || continue

            # A wired backhaul has no radio settings, but its kind still lets
            # the status table explain why those cells are empty.  The hardif
            # MAC identifies the local link in the status table.
            if hardif_is_wireless "$iface"; then
                kind=wlan
            else
                kind=wired
            fi
            mac=$(cat "/sys/class/net/$iface/address" 2>/dev/null)
            if [ -n "$mac" ]; then
                printf 'kind %s %s %s\n' "$iface" "$kind" "$mac"
            else
                printf 'kind %s %s\n' "$iface" "$kind"
            fi

            [ "$have_iw" = 1 ] || continue
            # iw prints "channel 37 (6135 MHz), width: 320 MHz".
            info=$(iw dev "$iface" info 2>/dev/null)
            link=$(printf '%s\n' "$info" \
                | sed -n 's/.*channel \([0-9][0-9]*\) (\([0-9][0-9]*\) MHz), width: \([0-9][0-9]*\) MHz.*/\2 \1 \3/p' \
                | head -n 1)
            if [ -z "$link" ]; then
                # Older drivers omit the width; keep reporting the frequency.
                link=$(printf '%s\n' "$info" \
                    | sed -n 's/.*channel [0-9][0-9]* (\([0-9][0-9]*\) MHz).*/\1/p' \
                    | head -n 1)
            fi
            [ -n "$link" ] && printf 'iface %s %s\n' "$iface" "$link"
            busy=$(iw dev "$iface" survey dump 2>/dev/null | awk '
                /^[[:space:]]*frequency:/ { inuse = ($0 ~ /\[in use\]/); next }
                inuse && /channel active time:/ { active = $4 }
                inuse && /channel busy time:/ { busy = $4 }
                END {
                    if (active + 0 > 0)
                        printf "%.0f", busy * 100 / active
                }
            ')
            [ -n "$busy" ] && printf 'busy %s %s\n' "$iface" "$busy"
            iw dev "$iface" station dump 2>/dev/null \
                | awk -v iface="$iface" '
                    /^Station / { mac = $2; next }
                    /^[[:space:]]*signal:/ { print "peer " iface " " mac " " $2 }
                '
        done
}

# Devices attached to this router, one line each for the "Connected Devices"
# section of the status page:
#   client <MAC> <iface> <hostname|-> <IPv4|-> <signal|dBm|->
#
# The AP interfaces and the LAN ports of the bridge are the local attachment
# points; bridge entries learned through bat0 belong to another mesh node and
# are left out.  A wireless station is also in the bridge table, so the
# station data is collected first and wins over the port entry.  A station
# that has been silent past MESHASSISTANT_STATION_INACTIVE_MAX is skipped:
# after a client roams away the old AP keeps a stale entry, with the signal
# from before the move, until hostapd drops it.
#
# Hostnames come from three places, in decreasing order of authority: this
# device's own lease file and static reservations (local_names), the name
# table the other mesh devices announce (announce_names), and finally a
# reverse lookup through the LAN gateway for a client that is still unnamed.
# A device that has none of them keeps the "-" placeholder.  Only wireless
# stations report a signal.
client_info() {
    local br gw port_no iface port mac ip name signal
    local -a macs=()
    local -A port_iface=() iface_by_mac=() signal_by_mac=() known_mac=()
    local -A ip_by_mac=() name_by_mac=()
    local -A ip_local=() name_announced=() ip_announced=()

    br=$(lan_device)

    # brctl prints decimal port numbers; sysfs reports them in hex.  Translate
    # the port number back to the interface the device is attached to.
    for iface in "$MESHASSISTANT_SYS_CLASS_NET/$br"/brif/*; do
        [ -e "$iface" ] || continue
        iface=${iface##*/}
        port_no=$(cat "$MESHASSISTANT_SYS_CLASS_NET/$br/brif/$iface/port_no" 2>/dev/null)
        [ -n "$port_no" ] || continue
        port_iface[$((port_no))]=$iface
    done

    if command -v iw >/dev/null 2>&1; then
        for port in "${!port_iface[@]}"; do
            iface=${port_iface[$port]}
            hardif_is_wireless "$iface" || continue
            while read -r mac signal; do
                [ -n "$mac" ] || continue
                mac=${mac,,}
                if [ -z "${known_mac[$mac]:-}" ]; then
                    known_mac[$mac]=1
                    macs+=("$mac")
                    iface_by_mac[$mac]=$iface
                    signal_by_mac[$mac]=$signal
                elif [ "$signal" -gt "${signal_by_mac[$mac]}" ] 2>/dev/null; then
                    iface_by_mac[$mac]=$iface
                    signal_by_mac[$mac]=$signal
                fi
            done < <(iw dev "$iface" station dump 2>/dev/null | awk \
                -v max="$((MESHASSISTANT_STATION_INACTIVE_MAX * 1000))" '
                /^Station / { mac = $2; inactive = 0; next }
                /^[[:space:]]*inactive time:/ { inactive = $3; next }
                /^[[:space:]]*signal:/ {
                    if (mac != "" && inactive <= max)
                        print mac, $2
                    mac = ""
                }
            ')
        done
    fi

    # Wired clients: bridge entries on a LAN port.  The bat0 port carries the
    # devices of other mesh nodes, and AP ports repeat the station addresses.
    if command -v brctl >/dev/null 2>&1; then
        while read -r port mac; do
            iface=${port_iface[$port]:-}
            [ -n "$iface" ] || continue
            [ "$iface" = "bat0" ] && continue
            hardif_is_wireless "$iface" && continue
            mac=${mac,,}
            [ -n "${known_mac[$mac]:-}" ] && continue
            known_mac[$mac]=1
            macs+=("$mac")
            iface_by_mac[$mac]=$iface
        done < <(brctl showmacs "$br" 2>/dev/null | awk '$3 == "no" { print $1, $2 }')
    fi

    # This device's own DHCP tables: the lease file and the static host
    # reservations.  A reservation overrides a lease name for the same MAC,
    # because local_names prints it after the lease line.
    while read -r mac ip name; do
        [ -n "$mac" ] || continue
        [ "$name" = '-' ] && continue
        name_by_mac[$mac]=$name
        case "$ip" in
            ''|-) ;;
            *) ip_local[$mac]=$ip ;;
        esac
    done < <(local_names)

    while read -r ip mac; do
        mac=${mac,,}
        [ -n "${ip_by_mac[$mac]:-}" ] || ip_by_mac[$mac]=$ip
    done < <(ip -4 neigh show dev "$br" 2>/dev/null \
        | awk '$2 == "lladdr" { print $1, $3 }')

    # The names other mesh devices announced.  They only fill in what this
    # device could not learn itself: the local lease/ARP data is authoritative
    # for a client attached here, and a later announcement line replaces an
    # earlier one.
    if [ -r "$MESHASSISTANT_NAMES" ]; then
        while read -r _ mac ip name; do
            [ -n "$mac" ] || continue
            [ "$name" = '-' ] || name_announced[$mac]=$name
            case "$ip" in
                ''|-) ;;
                *) ip_announced[$mac]=$ip ;;
            esac
        done < "$MESHASSISTANT_NAMES"
    fi

    # Nodes have no lease file; the server's dnsmasq answers reverse lookups
    # for its leased clients.  Prefer the configured LAN gateway, fall back to
    # the default route through the LAN device.
    gw=$(uci -q get network.lan.gateway)
    case "$gw" in
        [0-9]*.[0-9]*.[0-9]*.[0-9]*) ;;
        *)
            gw=$(ip -4 route show default 2>/dev/null | awk -v br="$br" '
                {
                    via = ""
                    for (i = 1; i < NF; i++) {
                        if ($i == "via") via = $(i + 1)
                        if ($i == "dev" && $(i + 1) == br && via != "") {
                            print via
                            exit
                        }
                    }
                }')
            ;;
    esac

    for mac in "${macs[@]}"; do
        ip=${ip_by_mac[$mac]:-}
        [ -n "$ip" ] || ip=${ip_local[$mac]:-}
        [ -n "$ip" ] || ip=${ip_announced[$mac]:-}
        name=${name_by_mac[$mac]:-}
        [ -n "$name" ] || name=${name_announced[$mac]:-}
        if [ -z "$name" ] && [ -n "$ip" ] && [ -n "$gw" ]; then
            name=$(client_reverse_name "$ip" "$gw")
        fi
        printf 'client %s %s %s %s %s\n' \
            "$mac" "${iface_by_mac[$mac]}" "${name:--}" "${ip:--}" \
            "${signal_by_mac[$mac]:--}"
    done | sort -k3,3 -k2,2
}

# Print the cached reverse-DNS answer for an address and return 0 on a hit.
# A stored "-" is a cached negative answer: the server does not know the
# address, so the caller gets no name and skips the lookup.
rdns_cache_get() {
    local ip="$1" now entry

    [ -r "$MESHASSISTANT_RDNS_CACHE" ] || return 1
    now=$(date +%s)
    entry=$(awk -v ip="$ip" -v now="$now" -v ttl="$MESHASSISTANT_RDNS_TTL" '
        $2 == ip && now - $1 < ttl { name = $3 }
        END { if (name != "") print name }' "$MESHASSISTANT_RDNS_CACHE")
    [ -n "$entry" ] || return 1
    [ "$entry" = '-' ] && return 0
    printf '%s\n' "$entry"
}

# Store one reverse-DNS answer.  Answers are appended under a lock so two
# concurrent client listings cannot interleave; expired entries are dropped
# when the file grows.
rdns_cache_put() {
    local ip="$1" name="$2" now

    [ -n "$ip" ] || return 0
    name=${name:--}
    now=$(date +%s)
    mkdir -p "${MESHASSISTANT_RDNS_CACHE%/*}" 2>/dev/null

    (
        if command -v flock >/dev/null 2>&1; then
            flock -x 9 2>/dev/null || :
        fi
        printf '%s %s %s\n' "$now" "$ip" "$name" >> "$MESHASSISTANT_RDNS_CACHE"
        if [ "$(wc -l < "$MESHASSISTANT_RDNS_CACHE")" -gt 400 ]; then
            awk -v now="$now" -v ttl="$MESHASSISTANT_RDNS_TTL" \
                'now - $1 < ttl' "$MESHASSISTANT_RDNS_CACHE" \
                > "$MESHASSISTANT_RDNS_CACHE.tmp" &&
                mv "$MESHASSISTANT_RDNS_CACHE.tmp" "$MESHASSISTANT_RDNS_CACHE"
        fi
    ) 9>"$MESHASSISTANT_RDNS_CACHE.lock"
}

# The hostname the server's dnsmasq has for a leased address, with the local
# search domain dropped.  A node does not run the DHCP server itself, so this
# is the only way it can name a client.
client_reverse_name() {
    local name

    if rdns_cache_get "$1"; then
        return 0
    fi

    command -v nslookup >/dev/null 2>&1 || return 0

    if command -v timeout >/dev/null 2>&1; then
        name=$(timeout 2 nslookup "$1" "$2" 2>/dev/null)
    else
        name=$(nslookup "$1" "$2" 2>/dev/null)
    fi
    name=$(printf '%s\n' "$name" | sed -n 's/.*name = //p' | head -n 1)
    name=${name%.lan}
    name=$(printf '%s' "$name" | tr -cd 'A-Za-z0-9._-')
    rdns_cache_put "$1" "$name"
    printf '%s\n' "$name"
}

# Truncate the run log shown by the "Run Log" tab.  Keep the file so the
# LuCI page can read it without treating a missing file as an error.
clear_log() {
    : > "$MESHASSISTANT_LOG"
}

# Enable meshassistant
enable_meshassistant() {
    # Drop a snapshot from an interrupted earlier run; apply_node_lan creates
    # a fresh one only when it applies a static LAN address.
    rm -f "$MESHASSISTANT_LAN_STATE"

    # This implementation supports one mesh radio.  Reject a multi-value
    # apRadio (for example from an older config) before touching network or
    # wireless config, instead of creating malformed wireless sections.
    AP_RADIO=$(uci -q get meshassistant.config.apRadio)
    set -- $AP_RADIO
    if [ "$#" -ne 1 ]; then
        echo "Error: exactly one Mesh radio must be selected (got '$AP_RADIO')."
        exit 1
    fi

    # The Mesh SSID names the 802.11s network.  Without it setup_mesh_radio()
    # cannot create the wireless device, but network.mesh_batman would still be
    # written: netifd then reports NO_DEVICE and LuCI shows "Device:
    # nonexistent".  Refuse before changing any configuration.
    if [ -z "$(uci -q get meshassistant.config.mesh_id)" ]; then
        echo "Error: Mesh SSID is empty. Set 'Mesh Network SSID' and apply again."
        exit 1
    fi

    # Clear stale wireless sections, but keep the section of the selected
    # radio so its wireless device never disappears.  process_radios()
    # rewrites all of its options in place.
    log_note "Phase: removing stale mesh wireless sections"
    clear_by_mesh_id "$(uci -q get meshassistant.config.mesh_id)" "mesh_$AP_RADIO"
    clear_by_mesh_id "$(uci -q get meshassistant.config.old_mesh_id)" "mesh_$AP_RADIO"
    uci set meshassistant.config.old_mesh_id="$(uci -q get meshassistant.config.mesh_id)"

    log_note "Phase: creating the batman network"
    create_batman_network

    log_note "Phase: applying spectrum settings"
    apply_spectrum_settings

    log_note "Phase: configuring the mesh and regular AP radios"
    if ! process_radios; then
        echo "Error: the mesh wireless configuration failed; aborting."
        exit 1
    fi

    log_note "Phase: applying network, firewall and WiFi settings"
    if ! apply_mesh_config; then
        echo "Error: applying the mesh configuration failed; aborting."
        exit 1
    fi

    # Set at end to be sure it worked
    uci set meshassistant.config.running=1
    uci_commit meshassistant

    # Start the peer identity service.  The init script stays enabled so the
    # announcements resume after a reboot; it only runs while the config is
    # enabled.
    log_note "Phase: starting the peer announcement service"
    log_note "Running: /etc/init.d/meshassistant enable"
    /etc/init.d/meshassistant enable >/dev/null 2>&1
    log_note "Running: /etc/init.d/meshassistant restart"
    /etc/init.d/meshassistant restart >/dev/null 2>&1
    log_note "Done."
}

# Disable meshassistant
disable_meshassistant() {
    # No watchdog check follows; drop any snapshot left by an interrupted run.
    rm -f "$MESHASSISTANT_LAN_STATE"

    # Clear old radios then set "old values"
    log_note "Phase: removing the mesh wireless sections"
    clear_by_mesh_id "$(uci -q get meshassistant.config.mesh_id)"
    clear_by_mesh_id "$(uci -q get meshassistant.config.old_mesh_id)"
    uci -q del meshassistant.config.old_mesh_id

    log_note "Phase: removing bat0 and mesh_batman, stopping the peer service"
    disable_batman_interfaces
    log_note "Running: /etc/init.d/meshassistant stop"
    /etc/init.d/meshassistant stop >/dev/null 2>&1

    # Undo everything the script changed outside the mesh interfaces: the LAN
    # bridge membership, the node LAN address/hostname, the LAN DHCP/RA
    # settings and the services it disabled.
    log_note "Phase: restoring the LAN bridge, address, DHCP and services"
    bridge_del_port bat0
    restore_node_lan_state
    restore_hostname_state
    restore_dhcp_lan_state
    restore_services

    # Remove our firewall additions again, but leave the other zones and their
    # uplink networks untouched.
    if [ "$(uci -q get meshassistant.config.lan_zone_bat0_added)" = 1 ]; then
        firewall_remove_network_everywhere bat0
        uci -q del meshassistant.config.lan_zone_bat0_added
    fi
    firewall_remove_network_everywhere mesh_batman
    if [ "$(uci -q get meshassistant.config.forwarding_added)" = 1 ]; then
        uci -q del firewall.meshassistant_lan_wan
        uci -q del meshassistant.config.forwarding_added
    fi

    uci_commit network
    uci_commit firewall
    uci_commit meshassistant

    log_note "Running: reload_config; /etc/init.d/network reload; wifi reload"
    reload_config
    /etc/init.d/network reload
    wifi reload

    # enabled is already 0 here, so setup_dawn stops DAWN if the plugin
    # started managing it.
    log_note "Phase: stopping client roaming"
    setup_dawn

    # Set at end to be sure it worked
    uci -q del meshassistant.config.running
    uci_commit meshassistant
    log_note "Done."
}

# ---------------------------------------------------------------------------
# Configuration backups
#
# The LuCI "Backup Management" tab and the automatic backup before a mesh
# apply both use these subcommands.  A backup is an uncompressed tar archive
# of the UCI config files plus a manifest with the creation time, hostname,
# LAN address, role and the enable state of the services the mesh script can
# change.  Restoring writes the files back, restores the recorded service
# states and reloads the network.  The archives contain WiFi and mesh keys, so
# the directory is 0700 and the files are 0600.
# ---------------------------------------------------------------------------

MESHASSISTANT_BACKUP_DIR=${MESHASSISTANT_BACKUP_DIR:-/etc/meshassistant/backup}
MESHASSISTANT_BACKUP_SELECTION=${MESHASSISTANT_BACKUP_SELECTION:-/tmp/meshassistant_backup_selection}
MESHASSISTANT_CONFIG_DIR=${MESHASSISTANT_CONFIG_DIR:-/etc/config}
MESHASSISTANT_BACKUP_CONFIGS="network wireless dhcp firewall system meshassistant"
# The directory is on flash and every mesh apply takes a backup, so keep only
# the newest archives.  The names are timestamps, so lexical order is
# chronological.
MESHASSISTANT_BACKUP_KEEP=${MESHASSISTANT_BACKUP_KEEP:-20}

# True while a service is enabled at boot.
backup_service_state() {
    if /etc/init.d/"$1" enabled >/dev/null 2>&1; then
        printf '1\n'
    else
        printf '0\n'
    fi
}

# Read one key from a manifest file.  Keys are fixed strings from the code.
backup_manifest_get() {
    local file="$1" key="$2"
    sed -n "s/^${key}=//p" "$file" 2>/dev/null | head -n 1
}

# Read and validate the filename written by the LuCI page.  Only a plain
# archive name in the backup directory is accepted; the selection file is
# removed even when the name is rejected.
backup_read_selection() {
    local name
    if [ ! -f "$MESHASSISTANT_BACKUP_SELECTION" ]; then
        echo "No backup was selected." >&2
        return 1
    fi

    name=$(cat "$MESHASSISTANT_BACKUP_SELECTION")
    rm -f "$MESHASSISTANT_BACKUP_SELECTION"

    case "$name" in
        ''|.*|*/*|*\\*|*..*|*[!A-Za-z0-9._-]*)
            echo "Invalid backup name." >&2
            return 1
            ;;
    esac

    # The pattern above accepts only plain archive names; require the suffix.
    case "$name" in
        *.tar) printf '%s\n' "$name" ;;
        *) echo "Invalid backup name." >&2; return 1 ;;
    esac
}

# Remove the oldest archives beyond the retention limit.  Temporary archives
# (hidden dotfiles) are never matched.
backup_prune() {
    local dir="$1" keep="$2" count file

    count=$(find "$dir" -maxdepth 1 -type f -name '*.tar' | wc -l)
    [ "$count" -gt "$keep" ] || return 0

    find "$dir" -maxdepth 1 -type f -name '*.tar' | sort | head -n $((count - keep)) |
        while read -r file; do
            rm -f "$file"
        done
}

# Create /etc/meshassistant/backup/<YYYYMMDD-HHMMSS>.tar from the current
# configuration.  A same-second collision gets a numeric suffix.
backup_create() {
    local dir="$MESHASSISTANT_BACKUP_DIR" cfgdir="$MESHASSISTANT_CONFIG_DIR"
    local stamp file tarball tmp config n=1
    local hostname ip role enabled created

    mkdir -p "$dir" || {
        echo "Unable to create the backup directory $dir." >&2
        return 1
    }
    chmod 700 "$dir" 2>/dev/null

    stamp=$(date '+%Y%m%d-%H%M%S')
    file="$dir/$stamp.tar"
    while [ -e "$file" ]; do
        file="$dir/$stamp-$n.tar"
        n=$((n + 1))
    done

    tmp=$(mktemp -d /tmp/meshassistant-backup.XXXXXX) || {
        echo "Unable to create a temporary directory." >&2
        return 1
    }

    mkdir -p "$tmp/etc/config"
    for config in $MESHASSISTANT_BACKUP_CONFIGS; do
        [ -f "$cfgdir/$config" ] && cp "$cfgdir/$config" "$tmp/etc/config/$config"
    done

    if [ ! -f "$tmp/etc/config/network" ]; then
        echo "No network configuration found in $cfgdir." >&2
        rm -rf "$tmp"
        return 1
    fi

    hostname=$(uci -q get system.@system[0].hostname)
    [ -n "$hostname" ] || hostname=$(cat /proc/sys/kernel/hostname 2>/dev/null)
    ip=$(lan_ipv4 2>/dev/null)
    role=$(uci -q get meshassistant.config.role)
    role=${role:-server}
    enabled=$(uci -q get meshassistant.config.enabled)
    enabled=${enabled:-0}
    created=$(date '+%Y-%m-%d %H:%M:%S')

    # Strip characters that would break the tab-separated "backup list" API.
    hostname=$(printf '%s' "$hostname" | tr '\t' ' ')
    role=$(printf '%s' "$role" | tr '\t' ' ')
    ip=$(printf '%s' "$ip" | tr '\t' ' ')

    {
        printf 'created=%s\n' "$created"
        printf 'hostname=%s\n' "$hostname"
        printf 'lan_ip=%s\n' "$ip"
        printf 'role=%s\n' "$role"
        printf 'enabled=%s\n' "$enabled"
        printf 'firewall=%s\n' "$(backup_service_state firewall)"
        printf 'dnsmasq=%s\n' "$(backup_service_state dnsmasq)"
        printf 'odhcpd=%s\n' "$(backup_service_state odhcpd)"
    } > "$tmp/manifest"

    # Build a hidden temporary archive first, so "backup list" never sees a
    # partially written file.
    tarball="$dir/.backup.$$"
    if ! tar -cf "$tarball" -C "$tmp" manifest etc/config; then
        echo "Unable to create the backup archive." >&2
        rm -rf "$tmp" "$tarball"
        return 1
    fi

    if ! mv "$tarball" "$file"; then
        echo "Unable to store the backup archive." >&2
        rm -rf "$tmp" "$tarball"
        return 1
    fi

    chmod 600 "$file"
    rm -rf "$tmp"
    backup_prune "$dir" "$MESHASSISTANT_BACKUP_KEEP"
    # Read by the backup subcommand dispatcher to record the action in the
    # run log; the function itself is also called without logging by a mesh
    # apply, whose own log already says that it is creating a backup.
    BACKUP_LAST_CREATED="$file"
    echo "Created backup: $file"
}

# Print one tab-separated line per archive:
#   name<TAB>created<TAB>hostname<TAB>lan_ip<TAB>role
backup_list() {
    local dir="$MESHASSISTANT_BACKUP_DIR" file manifest
    local name created hostname ip role

    [ -d "$dir" ] || return 0

    for file in "$dir"/*.tar; do
        [ -f "$file" ] || continue

        manifest=$(tar -xOf "$file" manifest 2>/dev/null) || manifest=''
        [ -n "$manifest" ] || continue

        name=$(basename "$file")
        created=$(printf '%s\n' "$manifest" | sed -n 's/^created=//p' | head -n 1)
        hostname=$(printf '%s\n' "$manifest" | sed -n 's/^hostname=//p' | head -n 1)
        ip=$(printf '%s\n' "$manifest" | sed -n 's/^lan_ip=//p' | head -n 1)
        role=$(printf '%s\n' "$manifest" | sed -n 's/^role=//p' | head -n 1)

        printf '%s\t%s\t%s\t%s\t%s\n' "$name" "$created" "$hostname" "$ip" "$role"
    done
}

# Check that the archive only contains the expected names.  This runs before
# extraction, so an archive with a path traversal entry cannot write outside
# the temporary directory.
backup_validate_archive() {
    local file="$1" entries entry
    local found_manifest=0 found_network=0

    entries=$(tar -tf "$file" 2>/dev/null) || {
        echo "The backup archive cannot be read." >&2
        return 1
    }

    while IFS= read -r entry; do
        [ -n "$entry" ] || continue
        case "$entry" in
            manifest) found_manifest=1 ;;
            etc/config/network) found_network=1 ;;
            etc|etc/|etc/config|etc/config/|etc/config/wireless|etc/config/dhcp|etc/config/firewall|etc/config/system|etc/config/meshassistant) ;;
            *)
                echo "Unexpected file in the backup: $entry" >&2
                return 1
                ;;
        esac
    done <<EOF
$entries
EOF

    if [ "$found_manifest" != 1 ] || [ "$found_network" != 1 ]; then
        echo "The backup is missing its manifest or network configuration." >&2
        return 1
    fi
}

backup_restore() {
    local name file tmp config service state

    name=$(backup_read_selection) || return 1
    file="$MESHASSISTANT_BACKUP_DIR/$name"

    if [ ! -f "$file" ]; then
        echo "Backup not found: $name" >&2
        return 1
    fi

    # The restore runs detached from LuCI, so this output is appended to the
    # run log; use the timestamped helper to mark where the restore began.
    log_note "Restoring backup: $file"

    # Keep a snapshot of the current configuration as well, so a restore can
    # itself be undone.  A failure here must not prevent the restore.
    backup_create >/dev/null || echo "Warning: could not create a safety backup."

    if ! backup_validate_archive "$file"; then
        return 1
    fi

    tmp=$(mktemp -d /tmp/meshassistant-restore.XXXXXX) || {
        echo "Unable to create a temporary directory." >&2
        return 1
    }

    if ! tar -xf "$file" -C "$tmp"; then
        echo "Unable to extract the backup archive." >&2
        rm -rf "$tmp"
        return 1
    fi

    # Refuse a corrupt UCI file instead of writing it over a working config.
    for config in $MESHASSISTANT_BACKUP_CONFIGS; do
        [ -f "$tmp/etc/config/$config" ] || continue
        if [ -L "$tmp/etc/config/$config" ]; then
            echo "The backup contains a symbolic link for $config." >&2
            rm -rf "$tmp"
            return 1
        fi
        if ! uci -q -c "$tmp/etc/config" show "$config" >/dev/null 2>&1; then
            echo "The backup contains an invalid $config configuration." >&2
            rm -rf "$tmp"
            return 1
        fi
    done

    for config in $MESHASSISTANT_BACKUP_CONFIGS; do
        [ -f "$tmp/etc/config/$config" ] || continue
        if ! cp "$tmp/etc/config/$config" "$MESHASSISTANT_CONFIG_DIR/$config"; then
            echo "Unable to restore the $config configuration." >&2
            rm -rf "$tmp"
            return 1
        fi
        echo "Restored $config."
    done

    # Restore the service enable state recorded by the backup.  A node backup
    # keeps firewall/dnsmasq/odhcpd disabled; a server backup keeps them on.
    for service in firewall dnsmasq odhcpd; do
        state=$(backup_manifest_get "$tmp/manifest" "$service")
        case "$state" in
            1)
                /etc/init.d/"$service" enable >/dev/null 2>&1
                /etc/init.d/"$service" start >/dev/null 2>&1
                ;;
            0)
                /etc/init.d/"$service" disable >/dev/null 2>&1
                /etc/init.d/"$service" stop >/dev/null 2>&1
                ;;
        esac
    done

    if [ "$(uci -q get meshassistant.config.enabled)" = 1 ]; then
        /etc/init.d/meshassistant enable >/dev/null 2>&1
        /etc/init.d/meshassistant restart >/dev/null 2>&1
    else
        /etc/init.d/meshassistant stop >/dev/null 2>&1
    fi

    rm -rf "$tmp"

    echo "Running: reload_config; /etc/init.d/network reload; wifi reload"
    reload_config
    /etc/init.d/network reload
    wifi reload

    log_note "Restore complete. The management address may have changed."
}

backup_delete() {
    local name file

    name=$(backup_read_selection) || return 1
    file="$MESHASSISTANT_BACKUP_DIR/$name"

    if [ ! -f "$file" ]; then
        echo "Backup not found: $name" >&2
        return 1
    fi

    rm -f "$file" || {
        echo "Unable to delete $name." >&2
        return 1
    }

    BACKUP_LAST_DELETED="$name"
    echo "Deleted backup: $name"
}

backup_clear() {
    local dir="$MESHASSISTANT_BACKUP_DIR" file count=0

    for file in "$dir"/*.tar; do
        [ -f "$file" ] || continue
        rm -f "$file" && count=$((count + 1))
    done

    rm -f "$MESHASSISTANT_BACKUP_SELECTION"
    BACKUP_LAST_COUNT="$count"
    echo "Deleted $count backup(s)."
}

if [ "$1" = "daemon" ]; then
    daemon_meshassistant
    exit 0
fi

if [ "$1" = "peer" ]; then
    record_peer
    exit 0
fi

if [ "$1" = "linkinfo" ]; then
    link_info
    exit 0
fi

if [ "$1" = "clients" ]; then
    client_info
    exit 0
fi

if [ "$1" = "capabilities" ]; then
    capabilities
    exit 0
fi

if [ "$1" = "clearlog" ]; then
    clear_log
    exit 0
fi

if [ "$1" = "backup" ]; then
    # The backup buttons call these subcommands without --detach, so their
    # output goes back to LuCI instead of the log; record the action in the
    # run log here.  "list" is a read on every page load and is not logged.
    case "$2" in
        create)
            take_run_lock
            backup_create
            rc=$?
            if [ "$rc" -eq 0 ]; then
                log_append "Created backup: $BACKUP_LAST_CREATED"
            else
                log_append "Backup creation failed."
            fi
            exit "$rc"
            ;;
        list) backup_list ;;
        restore)
            take_run_lock
            backup_restore
            ;;
        delete)
            take_run_lock
            backup_delete
            rc=$?
            if [ "$rc" -eq 0 ]; then
                log_append "Deleted backup: $BACKUP_LAST_DELETED"
            else
                log_append "Backup deletion failed."
            fi
            exit "$rc"
            ;;
        clear)
            take_run_lock
            backup_clear
            rc=$?
            if [ "$rc" -eq 0 ]; then
                log_append "Deleted $BACKUP_LAST_COUNT backup(s)."
            else
                log_append "Clearing the backups failed."
            fi
            exit "$rc"
            ;;
        *)
            echo "Usage: $0 backup {create|list|restore|delete|clear}" >&2
            exit 1
            ;;
    esac
    exit $?
fi

if [ "$1" = "dumbap" ]; then
    take_run_lock
    log_run_header "enabling Dumb AP mode"
    set_apmode
    exit $?
elif [ "$1" = "undumb" ]; then
    take_run_lock
    log_run_header "disabling Dumb AP mode"
    disable_apmode
    exit 0
# If no params passed, we disable or enable meshassistant based on config
else
    take_run_lock
    # Check if meshassistant is enabled
    if [ "$(uci -q get meshassistant.config.enabled)" = 1 ]; then
        log_run_header "enabling the mesh"
        log_note "Creating a configuration backup before applying"
        backup_create || log_note "Warning: the automatic backup failed; continuing."
        enable_meshassistant
    else
        log_run_header "disabling the mesh"
        log_note "Creating a configuration backup before applying"
        backup_create || log_note "Warning: the automatic backup failed; continuing."
        disable_meshassistant
    fi
fi