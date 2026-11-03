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

# Return immediately from LuCI RPC calls: wifi/network restarts may take
# longer than the RPC timeout and can drop the current browser connection.
if [ "$1" = "--detach" ]; then
    shift
    /meshassistant/meshassistant.sh "$@" >/tmp/meshassistant.log 2>&1 &
    exit 0
fi

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
        uci commit meshassistant
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
        uci commit meshassistant
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
    uci commit dhcp
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
    uci set meshassistant.config.lan_state_saved=1
}

restore_node_lan_state() {
    [ "$(uci -q get meshassistant.config.lan_state_saved)" = 1 ] || return 0
    uci_backup_restore meshassistant.config network.lan.proto lan_backup_proto
    uci_backup_restore meshassistant.config network.lan.ipaddr lan_backup_ipaddr
    uci_backup_restore meshassistant.config network.lan.netmask lan_backup_netmask
    uci_backup_restore meshassistant.config network.lan.gateway lan_backup_gateway
    uci_backup_restore meshassistant.config network.lan.dns lan_backup_dns
    uci -q del meshassistant.config.lan_state_saved
    uci commit network
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
    uci commit system
    echo "Restored the original hostname."
}

# Apply the AP Mode tab settings to a node.  This is also used by normal
# enable, not only by Dumb AP mode: IP Mode / static address / gateway /
# netmask / DNS / hostname are the node's management addressing.
apply_node_lan() {
    local ipmode hostname ipaddr netmask gateway dns

    ipmode=$(uci -q get meshassistant.config.ipmode)
    hostname=$(uci -q get meshassistant.config.hostname)

    save_node_lan_state

    if [ "$ipmode" = "static" ]; then
        ipaddr=$(uci -q get meshassistant.config.ipaddr)
        netmask=$(uci -q get meshassistant.config.netmask)
        gateway=$(uci -q get meshassistant.config.gateway)
        dns=$(uci -q get meshassistant.config.dns)

        uci set network.lan.proto='static'
        [ -n "$ipaddr" ] && uci set "network.lan.ipaddr=$ipaddr"
        [ -n "$netmask" ] && uci set "network.lan.netmask=$netmask"
        [ -n "$gateway" ] && uci set "network.lan.gateway=$gateway"
        [ -n "$dns" ] && uci_set_value network.lan.dns "$dns"
        echo "Node LAN configured as static ${ipaddr:-<unset>}."
    else
        uci set network.lan.proto='dhcp'
        uci -q del network.lan.ipaddr
        uci -q del network.lan.netmask
        uci -q del network.lan.gateway
        uci -q del network.lan.dns
        echo "Node LAN configured as a DHCP client."
    fi

    if [ -n "$hostname" ]; then
        save_hostname_state
        uci set "system.@system[0].hostname=$hostname"
        echo "Node hostname set to '$hostname'."
    fi

    uci commit network
    uci commit system
    uci commit meshassistant
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
    # Backup our configs
    rm /etc/config/*.meshbak
    cp /etc/config/wireless /etc/config/wireless.meshbak
    cp /etc/config/network /etc/config/network.meshbak
    cp /etc/config/dhcp /etc/config/dhcp.meshbak
    cp /etc/config/system /etc/config/system.meshbak
    cp /etc/config/firewall /etc/config/firewall.meshbak

    uci set meshassistant.config.ap_mode_enabled=1

    # Disabling and stopping services not needed
    for service in firewall dnsmasq odhcpd; do
        if /etc/init.d/$service enabled; then
            echo "Disabling and stopping $service..."
            /etc/init.d/$service disable >/dev/null 2>&1
            /etc/init.d/$service stop >/dev/null 2>&1
        else
            echo "$service is not enabled, skipping..."
        fi
    done

    if [ "$(uci -q get meshassistant.config.ipmode)" == "static" ]; then
        # Set static IP
        uci set network.lan.proto='static'
        uci set network.lan.ipaddr=$(uci -q get meshassistant.config.ipaddr)
        uci set network.lan.netmask=$(uci -q get meshassistant.config.netmask)
        uci set network.lan.gateway=$(uci -q get meshassistant.config.gateway)
        uci set network.lan.dns=$(uci -q get meshassistant.config.dns)
    else
        # Set LAN interface to DHCP client
        uci -q del network.lan.ipaddr
        uci -q del network.lan.netmask
        uci -q del network.lan.gateway
        uci -q del network.lan.dns
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
    # Set netmask and gateway (assuming $netmask and $dns didn't break more stuff)
    uci set system.@system[0].hostname=$HOSTNAME

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
                        uci commit wireless
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
    uci commit

    # Restart wireless
    wifi reload

    # Tell openwrt to reload the configs
    reload_config
    /etc/init.d/network reload
}

disable_apmode() {
    # Config Count Must Match 5
    local CONFIG_COUNT=0

    # Check our configs exist, then restore them
    [ -f /etc/config/wireless.meshbak ] && {
        CONFIG_COUNT=$((CONFIG_COUNT+1))
    }
    [ -f /etc/config/network.meshbak ] && {
        CONFIG_COUNT=$((CONFIG_COUNT+1))
    }
    [ -f /etc/config/dhcp.meshbak ] && {
        CONFIG_COUNT=$((CONFIG_COUNT+1))
    }
    [ -f /etc/config/system.meshbak ] && {
        CONFIG_COUNT=$((CONFIG_COUNT+1))
    }
    [ -f /etc/config/firewall.meshbak ] && {
        CONFIG_COUNT=$((CONFIG_COUNT+1))
    }

    # Check if we have 5 configs to restore
    if [ $CONFIG_COUNT -eq 5 ]; then
        echo "Restoring configs from backup..."
        echo "Existing configs will be moved to /etc/config/*.dumbap for reference."
        rm /etc/config/*.dumbap
        mv /etc/config/dhcp /etc/config/dhcp.dumbap
        mv /etc/config/network /etc/config/network.dumbap
        mv /etc/config/wireless /etc/config/wireless.dumbap
        mv /etc/config/system /etc/config/system.dumbap
        mv /etc/config/firewall /etc/config/firewall.dumbap
        mv /etc/config/dhcp.meshbak /etc/config/dhcp
        mv /etc/config/network.meshbak /etc/config/network
        mv /etc/config/wireless.meshbak /etc/config/wireless
        mv /etc/config/system.meshbak /etc/config/system
        mv /etc/config/firewall.meshbak /etc/config/firewall

        # Enable and start services not needed
        for service in firewall dnsmasq odhcpd; do
            if /etc/init.d/$service disabled; then
                echo "Enabling and starting $service..."
                /etc/init.d/$service enable
                /etc/init.d/$service start
            else
                echo "$service is not disabled, skipping..."
            fi
        done

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
    uci commit wireless
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

    # Set the bat0 role
    BAT_ROLE=$(uci -q get meshassistant.config.role)
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
        uci commit firewall

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
                uci commit dhcp
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
    uci commit network
    uci commit meshassistant

    echo "Network settings updated."
}

process_radios() {
    # Get the radio to be used for mesh from the config
    AP_RADIO=$(uci -q get meshassistant.config.apRadio)

    # Check if AP_RADIO is empty, if so exit
    if [ -z "$AP_RADIO" ]; then
        echo "No radio specified in the config, exiting."
        exit 1
    fi

    # Loop through the selected radios
    for CURRENT_RADIO in $AP_RADIO; do
        echo "Setting up mesh networks for: $CURRENT_RADIO"
        setup_mesh_radio "$CURRENT_RADIO"
    done
}

# This is called from the process_radios function and is passed the radio to be used for mesh
setup_mesh_radio() {
    echo "Setting up radios for Mesh and Regular WiFi"

    local CURRENT_RADIO="$1"

    # Get the regular WiFi SSID and radio from the config
    WIFI_ID=$(uci -q get meshassistant.config.wifi_id)
    WIFI_RADIO=$(uci -q get meshassistant.config.wifi_radio)

    # Get the mesh name from the config
    MESH_ID=$(uci -q get meshassistant.config.mesh_id)

    # Ensure both SSIDs are set
    if [ -z "$WIFI_ID" ]; then
        echo "Regular WiFi SSID is empty. Using default."
        WIFI_ID="meshassistant_AC"
    fi
    if [ -z "$MESH_ID" ]; then
        echo "Error: Mesh SSID is empty. Cannot configure mesh."
        return
    fi
    if [ -z "$CURRENT_RADIO" ]; then
        echo "Error: Mesh radio is empty. Cannot configure mesh."
        return
    fi

    # Generate Mesh AP SSID by appending '-mesh'
    MESH_SSID="${MESH_ID}-mesh"

    echo "Regular AP SSID: $WIFI_ID on $WIFI_RADIO"
    echo "Mesh SSID: $MESH_SSID on $CURRENT_RADIO"

    # Get the mobility domain from the config
    MOBILITY_DOMAIN=$(uci -q get meshassistant.config.mobility_domain)

    # If mobility domain is empty, generate a random 4-digit hex
    if [ -z "$MOBILITY_DOMAIN" ]; then
        MOBILITY_DOMAIN=$(hexdump -n 2 -e '2/1 "%02x"' /dev/urandom)
        uci set meshassistant.config.mobility_domain=$MOBILITY_DOMAIN
        uci commit meshassistant
    fi

    # Get encryption settings
    ENCRYPTION_ENABLED=$(uci -q get meshassistant.config.encryption)
    NETWORK_KEY=$(uci -q get meshassistant.config.key)

    ###### Regular WiFi AP Configuration (Set first, then apply WiFi) ######
    if [ ! -z "$WIFI_RADIO" ]; then
        echo "Configuring regular WiFi AP on $WIFI_RADIO"

        uci set wireless.wifi_ap_$WIFI_RADIO='wifi-iface'
        uci set wireless.wifi_ap_$WIFI_RADIO.device="$WIFI_RADIO"
        uci set wireless.wifi_ap_$WIFI_RADIO.mode='ap'
        uci set wireless.wifi_ap_$WIFI_RADIO.ssid="$WIFI_ID"
        uci set wireless.wifi_ap_$WIFI_RADIO.network='lan'
        uci set wireless.wifi_ap_$WIFI_RADIO.ieee80211r='1'
        uci set wireless.wifi_ap_$WIFI_RADIO.mobility_domain=$MOBILITY_DOMAIN
        uci set wireless.wifi_ap_$WIFI_RADIO.ft_over_ds='0'
        uci set wireless.wifi_ap_$WIFI_RADIO.ft_psk_generate_local='0'
        uci set wireless.wifi_ap_$WIFI_RADIO.disabled=0  # ?? Force-enable AP

        # Apply encryption settings for regular WiFi
        if [ "$ENCRYPTION_ENABLED" = 1 ] && [ ! -z "$NETWORK_KEY" ]; then
            uci set wireless.wifi_ap_$WIFI_RADIO.encryption='sae-mixed'
            uci set wireless.wifi_ap_$WIFI_RADIO.key=$NETWORK_KEY
        else
            uci set wireless.wifi_ap_$WIFI_RADIO.encryption='none'
            [ -z "$NETWORK_KEY" ] && echo "Encryption key is empty, so encryption was disabled."
        fi

        uci commit wireless
    fi

    ###### Mesh AP Configuration (Set after regular AP is applied) ######
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

        # Apply encryption settings for mesh
        if [ "$ENCRYPTION_ENABLED" = 1 ] && [ ! -z "$NETWORK_KEY" ]; then
            uci set wireless.mesh_$CURRENT_RADIO.encryption='sae'
            uci set wireless.mesh_$CURRENT_RADIO.key=$NETWORK_KEY
        else
            uci set wireless.mesh_$CURRENT_RADIO.encryption='none'
        fi

        uci commit wireless
    fi
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

    uci commit wireless

    # netifd reads /etc/config/network first, so bat0 and mesh_batman exist
    # before the 802.11s interface is created and attached to mesh_batman.
    # reload_config then applies the firewall, DHCP and system changes.
    /etc/init.d/network reload
    wifi reload
    reload_config
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

    uci commit network
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
# each other's address in advance.
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

# Addresses of every batman-adv hardif.  A neighbor can be reached through the
# Mesh radio or through a wired backhaul port; "batctl n" reports the MAC of
# the hardif that carries the link, so all of them have to be announced.
mesh_hardif_macs() {
    local iface mac
    for iface in $(batctl meshif bat0 interface 2>/dev/null \
            | sed -n 's/^\([^:]*\):.*/\1/p'); do
        [ -r "/sys/class/net/$iface/address" ] || continue
        mac=$(cat "/sys/class/net/$iface/address" 2>/dev/null)
        [ -n "$mac" ] && printf '%s\n' "$mac"
    done
}

announce_identity() {
    local ip brd hostname load mac
    ip=$(lan_ipv4)
    [ -n "$ip" ] || return 0

    brd=$(lan_broadcast)
    [ -n "$brd" ] || brd=255.255.255.255

    hostname=$(uci -q get system.@system[0].hostname)
    [ -n "$hostname" ] || hostname=$(cat /proc/sys/kernel/hostname 2>/dev/null)
    hostname=$(printf '%s' "$hostname" | tr -cd 'A-Za-z0-9._-')
    [ -n "$hostname" ] || hostname='-'

    # Version 2 appends the 1-minute load average.  Older receivers drop
    # unknown versions, so they never mistake the extra field for a hostname.
    load=$(cut -d' ' -f1 /proc/loadavg 2>/dev/null)
    case "$load" in
        ''|*[!0-9.]*|*.*.*) load='-' ;;
    esac

    for mac in $(mesh_hardif_macs); do
        printf 'meshassistant/2 %s %s %s %s\n' "$mac" "$ip" "$hostname" "$load" \
            | socat -u - "UDP-DATAGRAM:$brd:$MESHASSISTANT_PORT,broadcast" 2>/dev/null
    done
}

# Called by socat for every received datagram; the datagram is on stdin.
record_peer() {
    local proto mac ip hostname load ts
    read -r proto mac ip hostname load || true
    case "$proto" in
        meshassistant/1) load='' ;;
        meshassistant/2) ;;
        *) return 0 ;;
    esac

    mac=$(printf '%s' "$mac" | tr 'A-F' 'a-f')
    case "$mac" in
        [0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]:[0-9a-f][0-9a-f]) ;;
        *) return 0 ;;
    esac

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
    printf '%s %s %s %s %s\n' "$ts" "$mac" "${ip:--}" "$hostname" "${load:--}" \
        >> "$MESHASSISTANT_PEERS"
}

# Drop announcements that were not refreshed within the maximum age.
prune_peers() {
    local now tmp
    [ -f "$MESHASSISTANT_PEERS" ] || return 0
    now=$(date +%s)
    tmp="$MESHASSISTANT_PEERS.$$"
    if awk -v now="$now" -v max="$MESHASSISTANT_PEER_MAX_AGE" \
            '($1 + 0) >= now - max' "$MESHASSISTANT_PEERS" >"$tmp" 2>/dev/null; then
        mv "$tmp" "$MESHASSISTANT_PEERS"
    else
        rm -f "$tmp"
    fi
}

daemon_meshassistant() {
    local listener

    if ! command -v socat >/dev/null 2>&1; then
        echo "socat is not installed; peer announcements are disabled."
        exit 0
    fi

    : > "$MESHASSISTANT_PEERS"
    socat -u "UDP-RECVFROM:$MESHASSISTANT_PORT,reuseaddr,fork" \
        "EXEC:/meshassistant/meshassistant.sh peer" >/dev/null 2>&1 &
    listener=$!

    trap "kill $listener 2>/dev/null; rm -f '$MESHASSISTANT_PEERS'; exit 0" INT TERM
    trap "kill $listener 2>/dev/null; rm -f '$MESHASSISTANT_PEERS'" EXIT

    while true; do
        announce_identity
        prune_peers
        sleep "$MESHASSISTANT_ANNOUNCE_INTERVAL" &
        wait $!
    done
}

# Frequency, channel utilization and signal of the active mesh links.  "batctl
# n" only reports the MAC of the hardif that carries each link; the radio driver
# knows the channel, its busy time and the signal of each station.  Print one
# value per line so the LuCI view can merge it with the neighbor rows without
# parsing iw's multi-line output:
#   iface <hardif> <MHz>
#   busy <hardif> <percent>
#   peer <hardif> <MAC> <dBm>
link_info() {
    command -v iw >/dev/null 2>&1 || return 0

    batctl meshif bat0 interface 2>/dev/null \
        | sed -n 's/^\([^:]*\):.*/\1/p' \
        | while read -r iface; do
            [ -n "$iface" ] || continue
            freq=$(iw dev "$iface" info 2>/dev/null \
                | sed -n 's/.*channel [0-9][0-9]* (\([0-9][0-9]*\) MHz).*/\1/p' \
                | head -n 1)
            [ -n "$freq" ] && printf 'iface %s %s\n' "$iface" "$freq"
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

# Enable meshassistant
enable_meshassistant() {
    # This implementation supports one mesh radio.  Reject a multi-value
    # apRadio (for example from an older config) before touching network or
    # wireless config, instead of creating malformed wireless sections.
    AP_RADIO=$(uci -q get meshassistant.config.apRadio)
    set -- $AP_RADIO
    if [ "$#" -ne 1 ]; then
        echo "Error: exactly one Mesh radio must be selected (got '$AP_RADIO')."
        exit 1
    fi

    # Clear stale wireless sections, but keep the section of the selected
    # radio so its wireless device never disappears.  process_radios()
    # rewrites all of its options in place.
    clear_by_mesh_id "$(uci -q get meshassistant.config.mesh_id)" "mesh_$AP_RADIO"
    clear_by_mesh_id "$(uci -q get meshassistant.config.old_mesh_id)" "mesh_$AP_RADIO"
    uci set meshassistant.config.old_mesh_id="$(uci -q get meshassistant.config.mesh_id)"
    create_batman_network
    process_radios
    apply_mesh_config
    # Set at end to be sure it worked
    uci set meshassistant.config.running=1
    uci commit meshassistant

    # Start the peer identity service.  The init script stays enabled so the
    # announcements resume after a reboot; it only runs while the config is
    # enabled.
    /etc/init.d/meshassistant enable >/dev/null 2>&1
    /etc/init.d/meshassistant restart >/dev/null 2>&1
}

# Disable meshassistant
disable_meshassistant() {
    # Clear old radios then set "old values"
    clear_by_mesh_id "$(uci -q get meshassistant.config.mesh_id)"
    clear_by_mesh_id "$(uci -q get meshassistant.config.old_mesh_id)"
    uci -q del meshassistant.config.old_mesh_id
    disable_batman_interfaces
    /etc/init.d/meshassistant stop >/dev/null 2>&1

    # Undo everything the script changed outside the mesh interfaces: the LAN
    # bridge membership, the node LAN address/hostname, the LAN DHCP/RA
    # settings and the services it disabled.
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

    uci commit network
    uci commit firewall
    uci commit meshassistant

    reload_config
    /etc/init.d/network reload
    wifi reload

    # Set at end to be sure it worked
    uci -q del meshassistant.config.running
    uci commit meshassistant
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

if [ "$1" = "dumbap" ]; then
    set_apmode
    exit 0
elif [ "$1" = "undumb" ]; then
    disable_apmode
    exit 0
# If no params passed, we disable or enable meshassistant based on config
else
    # Check if meshassistant is enabled
    if [ "$(uci -q get meshassistant.config.enabled)" = 1 ]; then
        enable_meshassistant
    else
        disable_meshassistant
    fi
fi