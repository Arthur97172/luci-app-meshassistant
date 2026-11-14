'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('./lib');

function buildHarness() {
	let src = lib.read('root/etc/meshassistant/shell/meshassistant.sh');

	// Do not run the command dispatcher when the script is sourced.
	const marker = 'if [ "$1" = "dumbap" ]; then';
	const idx = src.indexOf(marker);

	if (idx < 0)
		throw new Error('command dispatcher not found in meshassistant.sh');

	src = src.slice(0, idx);

	// Network restarts and wifi reloads are outside the scope of this
	// UCI-state test.  The firewall/dnsmasq/odhcpd init scripts are replaced by
	// small fakes so service enable/disable state can be asserted.
	src = src
		.split('/etc/init.d/network reload').join(':')
		.split('/etc/init.d/network restart').join(':')
		.split('/etc/init.d/wireless restart').join(':')
		.split('/etc/init.d/').join('"$TEST_INITD"/');

	return `#!/bin/bash
set +e

: "\${TEST_INITD:?}"
: "\${TEST_INITD_STATE:?}"

declare -A CFG

uci() {
	local quiet=0
	if [ "$1" = "-q" ]; then
		quiet=1
		shift
	fi

	local cmd="$1"
	shift

	case "$cmd" in
		get)
			local key="$1"
			if [ -n "\${CFG[$key]+x}" ]; then
				printf '%s\\n' "\${CFG[$key]}"
				return 0
			fi
			return 1
			;;
		set)
			local arg="$1"
			local key="\${arg%%=*}"
			local val="\${arg#*=}"
			[ "$key" = "$arg" ] && return 1
			CFG["$key"]="$val"
			;;
		add_list)
			local arg="$1"
			local key="\${arg%%=*}"
			local val="\${arg#*=}"
			[ "$key" = "$arg" ] && return 1
			if [ -n "\${CFG[$key]+x}" ]; then
				CFG["$key"]="\${CFG[$key]} $val"
			else
				CFG["$key"]="$val"
			fi
			;;
		del_list)
			local arg="$1"
			local key="\${arg%%=*}"
			local val="\${arg#*=}"
			[ "$key" = "$arg" ] && return 1
			if [ -n "\${CFG[$key]+x}" ]; then
				local out="" item
				for item in \${CFG[$key]}; do
					[ "$item" = "$val" ] || out="$out $item"
				done
				CFG["$key"]="\${out# }"
			fi
			;;
		del|delete)
			local key="$1"
			local k
			for k in "\${!CFG[@]}"; do
				if [ "$k" = "$key" ] || [[ "$k" == "$key".* ]]; then
					unset "CFG[$k]"
				fi
			done
			;;
		show)
			local k rest
			for k in "\${!CFG[@]}"; do
				rest="\${k#*.}"
				if [[ "$rest" == *.* ]]; then
					printf "%s='%s'\\n" "$k" "\${CFG[$k]}"
				else
					printf "%s=%s\\n" "$k" "\${CFG[$k]}"
				fi
			done | sort
			;;
		commit)
			;;
		*)
			;;
	esac

	return 0
}

wifi() { :; }
reload_config() { :; }
# The capability report asks procd for DAWN's respawn count.  The router
# callbacks run on the host, so keep the default probe failing until a test
# replaces these stubs.
ubus() { return 127; }
jsonfilter() { return 127; }
sleep() { :; }
hexdump() { printf '4f57'; }

MESHASSISTANT_LAN_STATE="$TEST_INITD_STATE/lan_state"
MESHASSISTANT_LOCK="$TEST_INITD_STATE/run.lock"
MESHASSISTANT_NAMES="$TEST_INITD_STATE/names"
MESHASSISTANT_LEASES="$TEST_INITD_STATE/leases"
MESHASSISTANT_CONFIG_DIR="$TEST_INITD_STATE/config"
MESHASSISTANT_RDNS_CACHE="$TEST_INITD_STATE/rdns"
MESHASSISTANT_RDNS_TTL=300
MESHASSISTANT_BACKUP_DIR="$TEST_INITD_STATE/backup"
DAWN_CONFIG="$TEST_INITD_STATE/dawn.config"
DAWN_MANAGED="$TEST_INITD_STATE/dawn_managed"
DAWN_BACKUP="$TEST_INITD_STATE/dawn.backup"
MESHASSISTANT_SYS_CLASS_NET="$TEST_INITD_STATE/sys-net"

${src}

reset_cfg() {
	CFG=()
	rm -rf "$TEST_INITD_STATE"
	mkdir -p "$TEST_INITD_STATE"
	local s
	for s in firewall dnsmasq odhcpd; do
		: > "$TEST_INITD_STATE/$s.enabled"
	done

	uci set meshassistant.config.role=server
	uci set meshassistant.config.apRadio=radio0
	uci set meshassistant.config.mesh_id=meshassistant_AC
	uci set meshassistant.config.wifi_id=meshassistant_AC
	uci set meshassistant.config.wifi_radio=radio1
	uci set meshassistant.config.encryption=0
	uci set meshassistant.config.mobility_domain=4f57

	uci set network.lan=interface
	uci set network.lan.device=br-lan
	uci set network.lan.proto=static
	uci set network.lan.ipaddr=192.168.10.1
	uci set network.lan.netmask=255.255.255.0
	uci set network.@device[0]=device
	uci set network.@device[0].name=br-lan
	uci set network.@device[0].type=bridge
	uci set network.@device[0].ports='lan2 lan3'

	uci set firewall.@zone[0]=zone
	uci set firewall.@zone[0].name=lan
	uci set firewall.@zone[0].network='lan'
	uci set firewall.@zone[1]=zone
	uci set firewall.@zone[1].name=wan
	uci set firewall.@zone[1].network='wwan'
	uci set firewall.@zone[1].masq=1
	uci set firewall.@forwarding[0]=forwarding
	uci set firewall.@forwarding[0].src=lan
	uci set firewall.@forwarding[0].dest=wan

	uci set dhcp.lan=dhcp
	uci set dhcp.lan.interface=lan
	uci set dhcp.lan.dhcpv4=server

	uci set system.@system[0]=system
	uci set system.@system[0].hostname=OpenWrt

	uci set wireless.radio0=wifi-device
	uci set wireless.radio1=wifi-device
}

# Files that set_apmode/disable_apmode copy and move around.
seed_etc_config() {
	mkdir -p "$MESHASSISTANT_CONFIG_DIR"
	local f
	for f in wireless network dhcp system firewall; do
		printf 'original %s\n' "$f" > "$MESHASSISTANT_CONFIG_DIR/$f"
	done
}

get_or_unset() {
	local v
	v=$(uci -q get "$1")
	if [ $? -eq 0 ]; then
		printf '%s' "$v"
	else
		printf 'UNSET'
	fi
}

# 1. Server first run and reapply must keep mesh_batman.master and must not
#    drop the wwan uplink from the WAN zone.
reset_cfg
create_batman_network >/dev/null
echo "server1_master=$(get_or_unset network.mesh_batman.master)"
echo "server1_proto=$(get_or_unset network.mesh_batman.proto)"
echo "server1_device=$(get_or_unset network.mesh_batman.device)"
echo "server1_gw=$(get_or_unset network.bat0.gw_mode)"
echo "server1_ports=$(get_or_unset 'network.@device[0].ports')"
echo "server1_lan_zone=$(get_or_unset 'firewall.@zone[0].network')"
echo "server1_wan_zone=$(get_or_unset 'firewall.@zone[1].network')"
echo "server1_forwarding_added=$(get_or_unset meshassistant.config.forwarding_added)"
echo "server1_forwarding_count=$(uci show firewall | grep -c '=forwarding')"
create_batman_network >/dev/null
echo "server2_master=$(get_or_unset network.mesh_batman.master)"
echo "server2_proto=$(get_or_unset network.mesh_batman.proto)"
echo "server2_device=$(get_or_unset network.mesh_batman.device)"
echo "server2_ports=$(get_or_unset 'network.@device[0].ports')"
echo "server2_forwarding_count=$(uci show firewall | grep -c '=forwarding')"

# 1b. LuCI omits the role option when its value equals the form default
#     (Server), so an empty role must still run the server branch.
reset_cfg
uci delete meshassistant.config.role
create_batman_network >/dev/null
echo "unset_role_gw=$(get_or_unset network.bat0.gw_mode)"
echo "unset_role_lan_zone=$(get_or_unset 'firewall.@zone[0].network')"

# 2. A stale hardif without master must be repaired in node mode.
reset_cfg
uci set meshassistant.config.role=off
uci set network.mesh_batman=interface
uci set network.mesh_batman.proto=batadv_hardif
create_batman_network >/dev/null
echo "node_repair_master=$(get_or_unset network.mesh_batman.master)"
echo "node_repair_proto=$(get_or_unset network.mesh_batman.proto)"

# 3. A fresh node run must create a complete hardif, keep the firewall zones,
#    leave the wan port out of br-lan, and record the disabled services.
reset_cfg
uci set meshassistant.config.role=off
create_batman_network >/dev/null
echo "node_fresh_master=$(get_or_unset network.mesh_batman.master)"
echo "node_fresh_gw=$(get_or_unset network.bat0.gw_mode)"
echo "node_fresh_ports=$(get_or_unset 'network.@device[0].ports')"
echo "node_fresh_zone0=$(get_or_unset 'firewall.@zone[0]')"
echo "node_fresh_zone1=$(get_or_unset 'firewall.@zone[1]')"
echo "node_fresh_wan_zone=$(get_or_unset 'firewall.@zone[1].network')"
echo "node_fresh_disabled_fw=$(get_or_unset meshassistant.config.disabled_firewall)"
echo "node_fresh_disabled_dns=$(get_or_unset meshassistant.config.disabled_dnsmasq)"
echo "node_fresh_disabled_odhcpd=$(get_or_unset meshassistant.config.disabled_odhcpd)"
echo "node_fresh_fw_state=$( [ -e "$TEST_INITD_STATE/firewall.enabled" ] && echo enabled || echo disabled )"

# 4. setup_mesh_radio must use the radio passed to it, not the whole list.
reset_cfg
setup_ap_radios >/dev/null 2>&1
setup_mesh_radio radio0 >/dev/null 2>&1
echo "mesh_section=$(get_or_unset wireless.mesh_radio0)"
echo "mesh_device=$(get_or_unset wireless.mesh_radio0.device)"
echo "mesh_network=$(get_or_unset wireless.mesh_radio0.network)"
echo "mesh_mode=$(get_or_unset wireless.mesh_radio0.mode)"
echo "mesh_id=$(get_or_unset wireless.mesh_radio0.mesh_id)"
echo "mesh_ifname=$(get_or_unset wireless.mesh_radio0.ifname)"
echo "ap_section=$(get_or_unset wireless.wifi_ap_radio1)"
echo "ap_device=$(get_or_unset wireless.wifi_ap_radio1.device)"
echo "ap_ssid=$(get_or_unset wireless.wifi_ap_radio1.ssid)"

# 4b. Both selected radios get a regular AP with the same SSID and key.
reset_cfg
uci set meshassistant.config.wifi_radio='radio0 radio1'
setup_ap_radios >/dev/null 2>&1
echo "multi_ap0=$(get_or_unset wireless.wifi_ap_radio0)"
echo "multi_ap0_device=$(get_or_unset wireless.wifi_ap_radio0.device)"
echo "multi_ap0_ssid=$(get_or_unset wireless.wifi_ap_radio0.ssid)"
echo "multi_ap1=$(get_or_unset wireless.wifi_ap_radio1)"
echo "multi_ap1_device=$(get_or_unset wireless.wifi_ap_radio1.device)"
echo "multi_ap1_ssid=$(get_or_unset wireless.wifi_ap_radio1.ssid)"
echo "multi_managed=$(get_or_unset meshassistant.config.ap_radios_managed)"

# 4b2. In separate mode each radio uses its own SSID when one is configured,
#      otherwise it falls back to the shared SSID.
reset_cfg
uci set meshassistant.config.wifi_radio='radio0 radio1'
uci set meshassistant.config.ssid_mode=separate
uci set meshassistant.config.wifi_id_radio0='ap_2g'
uci set meshassistant.config.wifi_id_radio1='ap_5g'
setup_ap_radios >/dev/null 2>&1
echo "sep_ap0_ssid=$(get_or_unset wireless.wifi_ap_radio0.ssid)"
echo "sep_ap1_ssid=$(get_or_unset wireless.wifi_ap_radio1.ssid)"

reset_cfg
uci set meshassistant.config.wifi_radio='radio0 radio1'
uci set meshassistant.config.ssid_mode=separate
uci set meshassistant.config.wifi_id_radio1='ap_5g'
setup_ap_radios >/dev/null 2>&1
echo "fallback_ap0_ssid=$(get_or_unset wireless.wifi_ap_radio0.ssid)"
echo "fallback_ap1_ssid=$(get_or_unset wireless.wifi_ap_radio1.ssid)"

# 4b4. A band-split radio section such as radio0_band2 must not end up with a
#      netdev name over the kernel's 15-byte limit: netifd rejected
#      mesh_radio0_band2 and the mesh vif never got a netdev.
reset_cfg
setup_mesh_radio radio0_band2 >/dev/null 2>&1
echo "band_mesh_section=$(get_or_unset wireless.mesh_radio0_band2)"
echo "band_mesh_ifname=$(get_or_unset wireless.mesh_radio0_band2.ifname)"

# 4b3. Same mode ignores per-radio SSIDs; MLO still uses the shared SSID.
reset_cfg
uci set meshassistant.config.wifi_radio='radio0 radio1'
uci set meshassistant.config.ssid_mode=same
uci set meshassistant.config.wifi_id_radio0='ap_2g'
uci set meshassistant.config.wifi_id_radio1='ap_5g'
setup_ap_radios >/dev/null 2>&1
echo "same_ap0_ssid=$(get_or_unset wireless.wifi_ap_radio0.ssid)"
echo "same_ap1_ssid=$(get_or_unset wireless.wifi_ap_radio1.ssid)"

reset_cfg
uci set meshassistant.config.wifi_radio='radio0 radio1'
uci set meshassistant.config.ssid_mode=separate
uci set meshassistant.config.wifi_id_radio0='ap_2g'
uci set meshassistant.config.wifi_id_radio1='ap_5g'
uci set meshassistant.config.mlo=1
setup_ap_radios >/dev/null 2>&1
echo "sep_mlo_ssid=$(get_or_unset wireless.wifi_ap_mlo.ssid)"

# 4c. Deselecting a managed radio removes its AP section; AP sections that the
#     user created (not recorded as managed) must survive.
reset_cfg
uci set meshassistant.config.ap_radios_managed='radio0 radio1'
uci set meshassistant.config.wifi_radio='radio1'
uci set wireless.wifi_ap_radio0=wifi-iface
uci set wireless.wifi_ap_radio0.mode=ap
uci set wireless.wifi_ap_radio2=wifi-iface
uci set wireless.wifi_ap_radio2.mode=ap
setup_ap_radios >/dev/null 2>&1
echo "stale_ap_removed=$(get_or_unset wireless.wifi_ap_radio0)"
echo "kept_ap=$(get_or_unset wireless.wifi_ap_radio1)"
echo "user_ap=$(get_or_unset wireless.wifi_ap_radio2)"
echo "stale_managed=$(get_or_unset meshassistant.config.ap_radios_managed)"

# 4d. A 6 GHz radio selected for the regular AP gets the same settings; hostapd
#     starts it as WPA3-only even with sae-mixed on this firmware.
reset_cfg
uci set meshassistant.config.wifi_radio='radio1 radio2'
uci set meshassistant.config.encryption=1
uci set meshassistant.config.key='secret123'
setup_ap_radios >/dev/null 2>&1
echo "ap6g_section=$(get_or_unset wireless.wifi_ap_radio2)"
echo "ap6g_device=$(get_or_unset wireless.wifi_ap_radio2.device)"
echo "ap6g_ssid=$(get_or_unset wireless.wifi_ap_radio2.ssid)"
echo "ap6g_encryption=$(get_or_unset wireless.wifi_ap_radio2.encryption)"
echo "ap6g_key=$(get_or_unset wireless.wifi_ap_radio2.key)"
echo "ap5g_encryption=$(get_or_unset wireless.wifi_ap_radio1.encryption)"
echo "ap6g_managed=$(get_or_unset meshassistant.config.ap_radios_managed)"

# 4e. With MLO enabled and two radios, one MLD section replaces the per-radio
#     AP sections, and every link radio is switched to EHT.
reset_cfg
uci set meshassistant.config.wifi_radio='radio0 radio1'
uci set meshassistant.config.mlo=1
uci set meshassistant.config.encryption=1
uci set meshassistant.config.key='secret123'
uci set wireless.radio0.htmode=HE40
uci set wireless.radio1.htmode=EHT160
uci set wireless.wifi_ap_radio0=wifi-iface
uci set wireless.wifi_ap_radio0.mode=ap
uci set wireless.wifi_ap_radio1=wifi-iface
uci set wireless.wifi_ap_radio1.mode=ap
setup_ap_radios >/dev/null 2>&1
echo "mlo_section=$(get_or_unset wireless.wifi_ap_mlo)"
echo "mlo_device=$(get_or_unset wireless.wifi_ap_mlo.device)"
echo "mlo_flag=$(get_or_unset wireless.wifi_ap_mlo.mlo)"
echo "mlo_mode=$(get_or_unset wireless.wifi_ap_mlo.mode)"
echo "mlo_ssid=$(get_or_unset wireless.wifi_ap_mlo.ssid)"
echo "mlo_network=$(get_or_unset wireless.wifi_ap_mlo.network)"
echo "mlo_disabled=$(get_or_unset wireless.wifi_ap_mlo.disabled)"
echo "mlo_encryption=$(get_or_unset wireless.wifi_ap_mlo.encryption)"
echo "mlo_key=$(get_or_unset wireless.wifi_ap_mlo.key)"
echo "mlo_ap0=$(get_or_unset wireless.wifi_ap_radio0)"
echo "mlo_ap1=$(get_or_unset wireless.wifi_ap_radio1)"
echo "mlo_htmode0=$(get_or_unset wireless.radio0.htmode)"
echo "mlo_htmode1=$(get_or_unset wireless.radio1.htmode)"
echo "mlo_managed=$(get_or_unset meshassistant.config.ap_radios_managed)"

# 4f. MLO is ignored unless exactly two radios are selected; an MLD section
#     left by an earlier run is removed and the radio htmode is untouched.
reset_cfg
uci set meshassistant.config.wifi_radio=radio1
uci set meshassistant.config.mlo=1
uci set wireless.radio1.htmode=HE80
uci set wireless.wifi_ap_mlo=wifi-iface
uci set wireless.wifi_ap_mlo.mlo=1
uci set wireless.wifi_ap_mlo.mode=ap
setup_ap_radios >/dev/null 2>&1
echo "one_radio_ap=$(get_or_unset wireless.wifi_ap_radio1)"
echo "one_radio_mlo=$(get_or_unset wireless.wifi_ap_mlo)"
echo "one_radio_htmode=$(get_or_unset wireless.radio1.htmode)"

# 4g. Turning MLO off restores the per-radio AP sections and deletes the MLD.
reset_cfg
uci set meshassistant.config.wifi_radio='radio0 radio1'
uci set wireless.wifi_ap_mlo=wifi-iface
uci set wireless.wifi_ap_mlo.mlo=1
uci set wireless.wifi_ap_mlo.mode=ap
setup_ap_radios >/dev/null 2>&1
echo "off_mlo=$(get_or_unset wireless.wifi_ap_mlo)"
echo "off_ap0=$(get_or_unset wireless.wifi_ap_radio0)"
echo "off_ap1=$(get_or_unset wireless.wifi_ap_radio1)"

# 4g1. A mesh password with spaces must reach UCI intact; word splitting
#      previously stored a truncated key and silently broke the backhaul.
reset_cfg
uci set meshassistant.config.encryption=1
uci set meshassistant.config.key='my home network'
setup_mesh_radio radio0 >/dev/null 2>&1
echo "mesh_key=$(get_or_unset wireless.mesh_radio0.key)"
echo "mesh_key_encryption=$(get_or_unset wireless.mesh_radio0.encryption)"

# 4g2. A failed key write must fail the radio setup instead of leaving an
#      encrypted mesh section without a usable key.
reset_cfg
uci set meshassistant.config.encryption=1
uci set meshassistant.config.key='my home network'
eval "$(declare -f uci | sed '1s/^uci/orig_uci/')"
uci() {
    if [ "$1" = "set" ] && [ "$2" = "wireless.mesh_radio0.key=my home network" ]; then
        return 255
    fi
    orig_uci "$@"
}
setup_mesh_radio radio0 >/dev/null 2>&1
echo "mesh_key_failure_status=$?"
unset -f uci
eval "$(declare -f orig_uci | sed '1s/^orig_uci/uci/')"
unset -f orig_uci

# 4h. An unknown or missing htmode falls back to 20 MHz when switched to EHT.
reset_cfg
uci set meshassistant.config.wifi_radio='radio0 radio1'
uci set meshassistant.config.mlo=1
uci set wireless.radio0.htmode=HT20
setup_ap_radios >/dev/null 2>&1
echo "mlo_htmode_ht=$(get_or_unset wireless.radio0.htmode)"
echo "mlo_htmode_missing=$(get_or_unset wireless.radio1.htmode)"

# 4h1. 802.11k/v follow the roaming switch; 11v is only written when the
#      installed wpad build was compiled with 802.11v support, because hostapd
#      refuses to start on an option it does not know.
reset_cfg
uci set meshassistant.config.kvr=1
wnm_supported() { return 0; }
setup_ap_radios >/dev/null 2>&1
echo "roam_k=$(get_or_unset wireless.wifi_ap_radio1.ieee80211k)"
echo "roam_v=$(get_or_unset wireless.wifi_ap_radio1.bss_transition)"

reset_cfg
uci set meshassistant.config.kvr=1
wnm_supported() { return 1; }
setup_ap_radios >/dev/null 2>&1
echo "roam_nov_k=$(get_or_unset wireless.wifi_ap_radio1.ieee80211k)"
echo "roam_nov_v=$(get_or_unset wireless.wifi_ap_radio1.bss_transition)"

# Roaming off removes both bits, including ones left by an earlier run.
reset_cfg
uci set wireless.wifi_ap_radio1.ieee80211k=1
uci set wireless.wifi_ap_radio1.bss_transition=1
setup_ap_radios >/dev/null 2>&1
echo "roam_off_k=$(get_or_unset wireless.wifi_ap_radio1.ieee80211k)"
echo "roam_off_v=$(get_or_unset wireless.wifi_ap_radio1.bss_transition)"

# 4h1a. 802.11r is a switch of its own: on by default regardless of 802.11k/v,
#       and off removes the whole fast-transition setup, including stale bits.
reset_cfg
setup_ap_radios >/dev/null 2>&1
echo "ft_default=$(get_or_unset wireless.wifi_ap_radio1.ieee80211r)"
echo "ft_default_md=$(get_or_unset wireless.wifi_ap_radio1.mobility_domain)"
echo "ft_default_ds=$(get_or_unset wireless.wifi_ap_radio1.ft_over_ds)"
echo "ft_default_psk=$(get_or_unset wireless.wifi_ap_radio1.ft_psk_generate_local)"

reset_cfg
uci set meshassistant.config.kvr=1
uci set meshassistant.config.ft=0
wnm_supported() { return 0; }
setup_ap_radios >/dev/null 2>&1
echo "ft_off_k=$(get_or_unset wireless.wifi_ap_radio1.ieee80211k)"
echo "ft_off_r=$(get_or_unset wireless.wifi_ap_radio1.ieee80211r)"

reset_cfg
uci set wireless.wifi_ap_radio1.ieee80211r=1
uci set wireless.wifi_ap_radio1.mobility_domain=dead
uci set wireless.wifi_ap_radio1.ft_over_ds=1
uci set wireless.wifi_ap_radio1.ft_psk_generate_local=1
uci set meshassistant.config.ft=0
setup_ap_radios >/dev/null 2>&1
echo "ft_off_md=$(get_or_unset wireless.wifi_ap_radio1.mobility_domain)"
echo "ft_off_ds=$(get_or_unset wireless.wifi_ap_radio1.ft_over_ds)"
echo "ft_off_psk=$(get_or_unset wireless.wifi_ap_radio1.ft_psk_generate_local)"

# 4h2. An unset Mobility Domain is derived from the Mesh SSID, so every node
#      of one mesh gets the same value.
reset_cfg
uci delete meshassistant.config.mobility_domain
setup_ap_radios >/dev/null 2>&1
echo "mobility_derived=$(get_or_unset meshassistant.config.mobility_domain)"
echo "mobility_ap=$(get_or_unset wireless.wifi_ap_radio1.mobility_domain)"

reset_cfg
uci delete meshassistant.config.mobility_domain
uci set meshassistant.config.mesh_id=other_mesh
setup_ap_radios >/dev/null 2>&1
echo "mobility_other=$(get_or_unset meshassistant.config.mobility_domain)"

reset_cfg
uci delete meshassistant.config.mobility_domain
setup_ap_radios >/dev/null 2>&1
echo "mobility_again=$(get_or_unset meshassistant.config.mobility_domain)"

# 4h3. With roaming enabled, DAWN is configured from the form values and the
#      first pre-existing /etc/config/dawn is kept aside.
reset_cfg
uci set meshassistant.config.enabled=1
uci set meshassistant.config.kvr=1
uci set meshassistant.config.rssi_val=-65
uci set meshassistant.config.low_rssi_val=-85
uci set meshassistant.config.key=secret123
uci set 'dawn.@network[0]'=network
printf 'original-dawn-config\n' >"$DAWN_CONFIG"
wnm_supported() { return 0; }
setup_dawn >/dev/null 2>&1
echo "dawn_global=$(get_or_unset dawn.global)"
echo "dawn_kicking=$(get_or_unset dawn.global.kicking)"
echo "dawn_threshold=$(get_or_unset dawn.global.kicking_threshold)"
echo "dawn_minkick=$(get_or_unset dawn.global.min_number_to_kick)"
echo "dawn_nr=$(get_or_unset dawn.global.set_hostapd_nr)"
echo "dawn_duration=$(get_or_unset dawn.global.duration)"
echo "dawn_good=$(get_or_unset dawn.802_11g.rssi_val)"
echo "dawn_good_a=$(get_or_unset dawn.802_11a.rssi_val)"
echo "dawn_bad=$(get_or_unset dawn.802_11g.low_rssi_val)"
echo "dawn_center=$(get_or_unset dawn.802_11g.rssi_center)"
echo "dawn_center_a=$(get_or_unset dawn.802_11a.rssi_center)"
echo "dawn_shared=$(get_or_unset 'dawn.@network[0].shared_key')"
echo "dawn_net_named=$(get_or_unset dawn.network)"
echo "dawn_managed=$([ -f "$DAWN_MANAGED" ] && echo yes || echo no)"
echo "dawn_enabled=$([ -e "$TEST_INITD_STATE/dawn.enabled" ] && echo enabled || echo disabled)"

# Empty thresholds fall back to the documented defaults.
uci delete meshassistant.config.rssi_val
uci delete meshassistant.config.low_rssi_val
setup_dawn >/dev/null 2>&1
echo "dawn_default_good=$(get_or_unset dawn.802_11g.rssi_val)"
echo "dawn_default_bad=$(get_or_unset dawn.802_11g.low_rssi_val)"

# 4h3a. Each band (2.4 GHz, 5 GHz, 6 GHz) can override the shared thresholds.
#       An empty per-band value inherits the shared one, and the 6 GHz metric
#       section is always created because DAWN looks it up by name.
uci set meshassistant.config.rssi_val=-60
uci set meshassistant.config.low_rssi_val=-88
uci set meshassistant.config.rssi_val_5g=-70
uci set meshassistant.config.low_rssi_val_5g=-80
uci set meshassistant.config.rssi_val_6g=-55
setup_dawn >/dev/null 2>&1
echo "band_ax_section=$(get_or_unset dawn.802_11ax)"
echo "band_g_good=$(get_or_unset dawn.802_11g.rssi_val)"
echo "band_g_bad=$(get_or_unset dawn.802_11g.low_rssi_val)"
echo "band_a_good=$(get_or_unset dawn.802_11a.rssi_val)"
echo "band_a_bad=$(get_or_unset dawn.802_11a.low_rssi_val)"
echo "band_a_center=$(get_or_unset dawn.802_11a.rssi_center)"
echo "band_ax_good=$(get_or_unset dawn.802_11ax.rssi_val)"
echo "band_ax_bad=$(get_or_unset dawn.802_11ax.low_rssi_val)"
echo "band_ax_center=$(get_or_unset dawn.802_11ax.rssi_center)"

# Deleting an override brings the band back to the shared thresholds.
uci delete meshassistant.config.rssi_val_5g
uci delete meshassistant.config.low_rssi_val_5g
uci delete meshassistant.config.rssi_val_6g
setup_dawn >/dev/null 2>&1
echo "band_a_inherit=$(get_or_unset dawn.802_11a.rssi_val)"
echo "band_ax_inherit=$(get_or_unset dawn.802_11ax.low_rssi_val)"

# Turning roaming off stops DAWN and restores the saved configuration.
uci set meshassistant.config.kvr=0
setup_dawn >/dev/null 2>&1
echo "dawn_restored=$(head -n 1 "$DAWN_CONFIG" 2>/dev/null)"
echo "dawn_released=$([ -f "$DAWN_MANAGED" ] && echo yes || echo no)"
echo "dawn_backup_gone=$([ -f "$DAWN_BACKUP" ] && echo yes || echo no)"
echo "dawn_off_state=$([ -e "$TEST_INITD_STATE/dawn.enabled" ] && echo enabled || echo disabled)"

# 4h4. Without 802.11v in wpad, a managed DAWN is released instead of being
#      started, and the warning names the packages that would support it.
reset_cfg
uci set meshassistant.config.enabled=1
uci set meshassistant.config.kvr=1
: >"$TEST_INITD_STATE/dawn.enabled"
printf 'original-dawn-config\n' >"$DAWN_CONFIG"
printf 'backup-dawn-config\n' >"$DAWN_BACKUP"
: >"$DAWN_MANAGED"
wnm_supported() { return 1; }
setup_dawn >"$TEST_INITD_STATE/dawn-unsupported.out" 2>&1
echo "dawn_nov_managed=$([ -f "$DAWN_MANAGED" ] && echo yes || echo no)"
echo "dawn_nov_state=$([ -e "$TEST_INITD_STATE/dawn.enabled" ] && echo enabled || echo disabled)"
echo "dawn_nov_restored=$(head -n 1 "$DAWN_CONFIG" 2>/dev/null)"
echo "dawn_nov_warning=$(grep -c 'no 802.11v support' "$TEST_INITD_STATE/dawn-unsupported.out")"

# 4h5. The run lock keeps a second operation from starting while the first
#      is still running.
mkdir -p "$TEST_INITD_STATE"
take_run_lock
echo "lock_first_rc=$?"
( take_run_lock ) >/dev/null 2>"$TEST_INITD_STATE/lock.err"
echo "lock_second_rc=$?"
echo "lock_second_msg=$(cat "$TEST_INITD_STATE/lock.err")"

# 4h6. The capability report behind the status-page hint follows the roaming
#      switch, the wpad probe and whether the DAWN init script is installed.
reset_cfg
wnm_supported() { return 0; }
echo "caps_off_supported=$(capabilities | tr '\n' '|')"

reset_cfg
uci set meshassistant.config.kvr=1
wnm_supported() { return 1; }
echo "caps_on_unsupported=$(capabilities | tr '\n' '|')"

reset_cfg
wnm_supported() { return 0; }
chmod -x "$TEST_INITD/dawn"
echo "caps_no_dawn=$(capabilities | tr '\n' '|')"
chmod +x "$TEST_INITD/dawn"

# DAWN is installed but its procd instance is down: the report has to say so,
# otherwise the status page cannot tell that clients are not being steered.
reset_cfg
wnm_supported() { return 0; }
echo "caps_dawn_stopped=$(capabilities | tr '\n' '|')"
: > "$TEST_INITD_STATE/dawn.running"
echo "caps_dawn_running=$(capabilities | tr '\n' '|')"

# A running DAWN also reports how often procd has respawned it, so the
# status page can tell a crash loop from a healthy service.
ubus() {
    printf '{"dawn":{"instances":{"instance1":{"respawn_count":7}}}}\n'
}
jsonfilter() {
    cat >/dev/null
    printf '7\n'
}
echo "caps_dawn_restarts=$(capabilities | tr '\n' '|')"
unset -f ubus jsonfilter

# The respawn count is omitted when procd cannot report it.
ubus() { return 127; }
jsonfilter() { return 127; }
echo "caps_dawn_restarts_unknown=$(capabilities | tr '\n' '|')"
capabilities >/dev/null 2>&1
echo "caps_rc=$?"
unset -f ubus jsonfilter
rm -f "$TEST_INITD_STATE/dawn.running"

# 4h7. The roaming report lists hostapd's transition counters per BSS, one
#      line per interface, so the view can tell steering actually happens.
ubus() {
    case "$1 $2" in
        "list hostapd.*")
            printf 'hostapd.phy0.0-ap0\nhostapd.phy0.1-ap0\n' ;;
        "call hostapd.phy0.0-ap0")
            printf '{"freq": 2462, "rrm": {"neighbor_report_tx": 40}, "wnm": {"bss_transition_request_tx": 26, "bss_transition_response_rx": 3}}\n' ;;
        "call hostapd.phy0.1-ap0")
            printf '{"freq": 5180}\n' ;;
        *)
            return 1 ;;
    esac
}
jsonfilter() {
    local expr="$1" input key
    input=$(cat)
    [ "$expr" = "-e" ] && expr="$2"
    key="\${expr##*.}"
    printf '%s\n' "$input" |
        grep -o "\\\"$key\\\":[[:space:]]*[0-9][0-9]*" | sed 's/.*[^0-9]//'
}
echo "roaming_report=$(roaming_report | tr '\n' '|')"
unset -f ubus jsonfilter

# Without ubus there is nothing to report and the command still succeeds.
echo "roaming_empty=$(roaming_report | wc -l)"

# 4i. Run log helpers timestamp messages and record committed changes with
#     secrets masked.
log_line=$(log_note "hello world")
echo "log_line=$log_line"

commit_log=$(
    uci() {
        [ "$1" = "-q" ] && shift
        case "$1" in
            changes)
                printf '%s\n' "wireless.wifi_ap_radio0.key='secret123'" \
                    "dawn.cfg0a1b2c.shared_key='186b38882493c85660fdd39cd3ec27f0'" \
                    "network.lan.ipaddr='192.168.10.1'"
                return 0
                ;;
            commit)
                return 0
                ;;
        esac
        return 0
    }
    uci_commit wireless
)
commit_log=$(printf '%s' "$commit_log" | tr '\n' '|')
echo "commit_log=$commit_log"

# 4j. Backup audit lines are appended to the run log file, and the log is
#     trimmed back under its size limit instead of growing without bound.
log_file="$TEST_INITD_STATE/append.log"
: > "$log_file"
MESHASSISTANT_LOG="$log_file"
MESHASSISTANT_LOG_MAX=200
log_append "Created backup: /etc/meshassistant/backup/test.tar"
echo "log_append_line=$(tail -n 1 "$log_file" | cut -d' ' -f3-)"
echo "log_append_timestamped=$(grep -c '^[[]' "$log_file")"
for i in $(seq 1 40); do
    log_append "line $i"
done
echo "log_trim_bytes=$(wc -c < "$log_file" | tr -d ' ')"
echo "log_trim_newest=$(tail -n 1 "$log_file" | cut -d' ' -f3-)"

# 5. Stale mesh sections with the "-mesh" suffix must be removed.
reset_cfg
uci set wireless.mesh_radio0=wifi-iface
uci set wireless.mesh_radio0.mesh_id='meshassistant_AC-mesh'
uci set wireless.mesh_radio1=wifi-iface
uci set wireless.mesh_radio1.mesh_id='other-mesh'
clear_by_mesh_id meshassistant_AC >/dev/null 2>&1
echo "clear_matching=$(get_or_unset wireless.mesh_radio0)"
echo "clear_other=$(get_or_unset wireless.mesh_radio1)"

# 6. Legacy wifinetN cleanup must only remove mesh_batman backhauls; a regular
#    AP with the same SSID must survive.
reset_cfg
uci set wireless.wifinet0=wifi-iface
uci set wireless.wifinet0.ssid='meshassistant_AC'
uci set wireless.wifinet0.mode='ap'
uci set wireless.wifinet0.network='lan'
uci set wireless.wifinet1=wifi-iface
uci set wireless.wifinet1.ssid='meshassistant_AC'
uci set wireless.wifinet1.mode='mesh'
uci set wireless.wifinet1.network='mesh_batman'
uci set wireless.wifinet2=wifi-iface
uci set wireless.wifinet2.ssid='other'
uci set wireless.wifinet2.mode='mesh'
uci set wireless.wifinet2.network='mesh_batman'
clear_by_mesh_id meshassistant_AC >/dev/null 2>&1
echo "legacy_regular_ap=$(get_or_unset wireless.wifinet0)"
echo "legacy_mesh_removed=$(get_or_unset wireless.wifinet1)"
echo "legacy_other_mesh=$(get_or_unset wireless.wifinet2)"

# 7. A multi-value apRadio must be rejected before applying anything.
reset_cfg
uci set meshassistant.config.apRadio='radio0 radio1'
multi_output=$( ( enable_meshassistant ) 2>&1 )
echo "multi_exit=$?"
echo "multi_output=$multi_output"

# 7b. An empty Mesh SSID must abort before creating network.mesh_batman.
#     Without the wireless mesh device netifd reports NO_DEVICE and LuCI shows
#     "Device: nonexistent".
reset_cfg
uci -q del meshassistant.config.mesh_id
mesh_empty_output=$( ( enable_meshassistant ) 2>&1 )
echo "mesh_empty_exit=$?"
echo "mesh_empty_output=$mesh_empty_output"
echo "mesh_empty_iface=$(get_or_unset network.mesh_batman)"
echo "mesh_empty_wireless=$(get_or_unset wireless.mesh_radio0)"
echo "mesh_empty_running=$(get_or_unset meshassistant.config.running)"

# 7c. The mesh helpers must report the failure to their callers.
reset_cfg
uci -q del meshassistant.config.mesh_id
if setup_mesh_radio radio0 >/dev/null 2>&1; then
	echo "mesh_setup_rc=0"
else
	echo "mesh_setup_rc=$?"
fi
if process_radios >/dev/null 2>&1; then
	echo "process_radios_rc=0"
else
	echo "process_radios_rc=$?"
fi
if apply_mesh_config >/dev/null 2>&1; then
	echo "apply_mesh_rc=0"
else
	echo "apply_mesh_rc=$?"
fi

# 8. Node mode must apply the AP Mode tab address/hostname and restore them on
#    disable.
reset_cfg
uci set meshassistant.config.role=off
uci set meshassistant.config.ipmode=static
uci set meshassistant.config.ipaddr=192.168.10.2
uci set meshassistant.config.netmask=255.255.255.0
uci set meshassistant.config.gateway=192.168.10.1
uci set meshassistant.config.dns=192.168.10.1
uci set meshassistant.config.hostname=node2
uci set network.lan.peerdns=0
create_batman_network >/dev/null
echo "node_static_proto=$(get_or_unset network.lan.proto)"
echo "node_static_ip=$(get_or_unset network.lan.ipaddr)"
echo "node_static_gw=$(get_or_unset network.lan.gateway)"
echo "node_static_dns=$(get_or_unset network.lan.dns)"
echo "node_static_peerdns=$(get_or_unset network.lan.peerdns)"
echo "node_static_hostname=$(get_or_unset 'system.@system[0].hostname')"
echo "node_saved_lan=$(get_or_unset meshassistant.config.lan_state_saved)"
echo "node_saved_hostname=$(get_or_unset meshassistant.config.hostname_state_saved)"
disable_meshassistant >/dev/null
echo "restore_proto=$(get_or_unset network.lan.proto)"
echo "restore_ip=$(get_or_unset network.lan.ipaddr)"
echo "restore_netmask=$(get_or_unset network.lan.netmask)"
echo "restore_gw=$(get_or_unset network.lan.gateway)"
echo "restore_dns=$(get_or_unset network.lan.dns)"
echo "restore_peerdns=$(get_or_unset network.lan.peerdns)"
echo "restore_hostname=$(get_or_unset 'system.@system[0].hostname')"
echo "restore_ports=$(get_or_unset 'network.@device[0].ports')"
echo "restore_bat0=$(get_or_unset network.bat0)"
echo "restore_hardif=$(get_or_unset network.mesh_batman)"
echo "restore_zone0=$(get_or_unset 'firewall.@zone[0]')"
echo "restore_disabled_fw=$(get_or_unset meshassistant.config.disabled_firewall)"
echo "restore_fw_state=$( [ -e "$TEST_INITD_STATE/firewall.enabled" ] && echo enabled || echo disabled )"
echo "restore_saved_lan=$(get_or_unset meshassistant.config.lan_state_saved)"

# 9. Node DHCP mode removes the static LAN options and applies a DNS
#    override; disable restores the original values.
reset_cfg
uci set meshassistant.config.role=off
uci set meshassistant.config.ipmode=dhcp
uci set meshassistant.config.hostname=node3
uci set meshassistant.config.dns=192.168.10.53
create_batman_network >/dev/null
echo "node_dhcp_proto=$(get_or_unset network.lan.proto)"
echo "node_dhcp_ip=$(get_or_unset network.lan.ipaddr)"
echo "node_dhcp_netmask=$(get_or_unset network.lan.netmask)"
echo "node_dhcp_dns=$(get_or_unset network.lan.dns)"
echo "node_dhcp_peerdns=$(get_or_unset network.lan.peerdns)"
disable_meshassistant >/dev/null
echo "node_dhcp_restore_proto=$(get_or_unset network.lan.proto)"
echo "node_dhcp_restore_ip=$(get_or_unset network.lan.ipaddr)"
echo "node_dhcp_restore_dns=$(get_or_unset network.lan.dns)"
echo "node_dhcp_restore_peerdns=$(get_or_unset network.lan.peerdns)"
echo "node_dhcp_restore_hostname=$(get_or_unset 'system.@system[0].hostname')"

# 9b. Without a DNS server in DHCP mode the advertised DNS servers stay in
#     use and any earlier override is removed.
reset_cfg
uci set meshassistant.config.role=off
uci set meshassistant.config.ipmode=dhcp
uci set meshassistant.config.hostname=node4
uci set network.lan.dns='192.168.10.77 192.168.10.78'
uci set network.lan.peerdns=0
create_batman_network >/dev/null
echo "node_dhcp_nodns_dns=$(get_or_unset network.lan.dns)"
echo "node_dhcp_nodns_peerdns=$(get_or_unset network.lan.peerdns)"

# 10. Server without DHCP support must disable LAN DHCP/RA and restore them
#     when the option is turned back on.
reset_cfg
uci set meshassistant.config.role=server
uci set meshassistant.config.server_dhcp=0
create_batman_network >/dev/null
echo "nodhcp_ignore=$(get_or_unset dhcp.lan.ignore)"
echo "nodhcp_ra=$(get_or_unset dhcp.lan.ra)"
echo "nodhcp_dhcpv6=$(get_or_unset dhcp.lan.dhcpv6)"
echo "nodhcp_disabled_odhcpd=$(get_or_unset meshassistant.config.disabled_odhcpd)"
echo "nodhcp_dns_state=$( [ -e "$TEST_INITD_STATE/dnsmasq.enabled" ] && echo enabled || echo disabled )"
echo "nodhcp_odhcpd_state=$( [ -e "$TEST_INITD_STATE/odhcpd.enabled" ] && echo enabled || echo disabled )"
uci set meshassistant.config.server_dhcp=1
create_batman_network >/dev/null
echo "dhcp_restored_ignore=$(get_or_unset dhcp.lan.ignore)"
echo "dhcp_restored_ra=$(get_or_unset dhcp.lan.ra)"
echo "dhcp_restored_disabled_odhcpd=$(get_or_unset meshassistant.config.disabled_odhcpd)"
echo "dhcp_restored_odhcpd_state=$( [ -e "$TEST_INITD_STATE/odhcpd.enabled" ] && echo enabled || echo disabled )"

# 11. A server with an empty WAN zone gets wan and NAT, and creates a single
#     forwarding rule.
reset_cfg
uci del firewall.@zone[1].network
uci set firewall.@zone[1].masq=0
uci del 'firewall.@forwarding[0]'
create_batman_network >/dev/null
echo "empty_wan_zone=$(get_or_unset 'firewall.@zone[1].network')"
echo "empty_wan_masq=$(get_or_unset 'firewall.@zone[1].masq')"
echo "empty_forwarding=$(get_or_unset firewall.meshassistant_lan_wan.src)"
echo "empty_forwarding_added=$(get_or_unset meshassistant.config.forwarding_added)"
disable_meshassistant >/dev/null
echo "empty_forwarding_removed=$(get_or_unset firewall.meshassistant_lan_wan)"
echo "empty_forwarding_flag=$(get_or_unset meshassistant.config.forwarding_added)"

# 12. Wired backhaul dedicates the port to bat0, removes it from the LAN
#     bridge and keeps the configuration across a reapply.
reset_cfg
mkdir -p "$MESHASSISTANT_SYS_CLASS_NET/lan3"
printf '10000\n' >"$MESHASSISTANT_SYS_CLASS_NET/lan3/speed"
uci set meshassistant.config.wired_backhaul=lan3
create_batman_network >/dev/null
echo "wired_proto=$(get_or_unset network.mesh_wired.proto)"
echo "wired_master=$(get_or_unset network.mesh_wired.master)"
echo "wired_device=$(get_or_unset network.mesh_wired.device)"
echo "wired_mtu=$(get_or_unset network.mesh_wired.mtu)"
echo "wired_override=$(get_or_unset network.mesh_wired.throughput_override)"
echo "wired_ports=$(get_or_unset 'network.@device[0].ports')"
echo "wired_removed=$(get_or_unset meshassistant.config.wired_backhaul_bridge_removed)"
echo "wired_restore=$(get_or_unset meshassistant.config.wired_backhaul_restore_port)"
create_batman_network >/dev/null
echo "wired_reapply_ports=$(get_or_unset 'network.@device[0].ports')"
echo "wired_reapply_device=$(get_or_unset network.mesh_wired.device)"

# 12b. The wired throughput follows the port's negotiated speed.  An unknown
#      speed (no sysfs entry) or a down port (-1) must not overwrite an
#      existing override, so a later reapply while the cable is out keeps it.
reset_cfg
uci set meshassistant.config.wired_backhaul=lan3
create_batman_network >/dev/null
echo "wired_override_unknown=$(get_or_unset network.mesh_wired.throughput_override)"

reset_cfg
mkdir -p "$MESHASSISTANT_SYS_CLASS_NET/lan3"
printf '%s\n' '-1' >"$MESHASSISTANT_SYS_CLASS_NET/lan3/speed"
uci set meshassistant.config.wired_backhaul=lan3
create_batman_network >/dev/null
echo "wired_override_down=$(get_or_unset network.mesh_wired.throughput_override)"

reset_cfg
mkdir -p "$MESHASSISTANT_SYS_CLASS_NET/lan3"
printf '2500\n' >"$MESHASSISTANT_SYS_CLASS_NET/lan3/speed"
uci set meshassistant.config.wired_backhaul=lan3
create_batman_network >/dev/null
printf '%s\n' '-1' >"$MESHASSISTANT_SYS_CLASS_NET/lan3/speed"
create_batman_network >/dev/null
echo "wired_override_kept=$(get_or_unset network.mesh_wired.throughput_override)"

# 13. A node uses the same wired hardif and keeps the port out of br-lan.
reset_cfg
uci set meshassistant.config.role=off
uci set meshassistant.config.wired_backhaul=lan2
create_batman_network >/dev/null
echo "wired_node_proto=$(get_or_unset network.mesh_wired.proto)"
echo "wired_node_master=$(get_or_unset network.mesh_wired.master)"
echo "wired_node_device=$(get_or_unset network.mesh_wired.device)"
echo "wired_node_ports=$(get_or_unset 'network.@device[0].ports')"
echo "wired_node_gw=$(get_or_unset network.bat0.gw_mode)"

# 14. Changing the selected port restores the old port and dedicates the new
#     one.
reset_cfg
uci set 'network.@device[0].ports=lan2 lan3 lan4'
uci set meshassistant.config.wired_backhaul=lan2
create_batman_network >/dev/null
uci set meshassistant.config.wired_backhaul=lan3
create_batman_network >/dev/null
echo "wired_change_device=$(get_or_unset network.mesh_wired.device)"
echo "wired_change_ports=$(get_or_unset 'network.@device[0].ports')"
echo "wired_change_restore=$(get_or_unset meshassistant.config.wired_backhaul_restore_port)"

# 15. Disabling restores the dedicated port but keeps the user's selection.
reset_cfg
uci set meshassistant.config.wired_backhaul=lan3
create_batman_network >/dev/null
disable_meshassistant >/dev/null
echo "wired_disable_iface=$(get_or_unset network.mesh_wired)"
echo "wired_disable_ports=$(get_or_unset 'network.@device[0].ports')"
echo "wired_disable_removed=$(get_or_unset meshassistant.config.wired_backhaul_bridge_removed)"
echo "wired_disable_restore=$(get_or_unset meshassistant.config.wired_backhaul_restore_port)"
echo "wired_disable_config=$(get_or_unset meshassistant.config.wired_backhaul)"

# 16. None keeps wireless-only backhaul and leaves the LAN bridge alone.
reset_cfg
uci set meshassistant.config.wired_backhaul=none
create_batman_network >/dev/null
echo "wired_none_iface=$(get_or_unset network.mesh_wired)"
echo "wired_none_ports=$(get_or_unset 'network.@device[0].ports')"

# 17. A port owned by another logical interface is refused.
reset_cfg
uci set network.wan=interface
uci set network.wan.device=lan3
uci set meshassistant.config.wired_backhaul=lan3
create_batman_network >/dev/null
echo "wired_busy_iface=$(get_or_unset network.mesh_wired)"
echo "wired_busy_ports=$(get_or_unset 'network.@device[0].ports')"

# 18. A port that is not part of the LAN bridge is refused.
reset_cfg
uci set meshassistant.config.wired_backhaul=lan4
create_batman_network >/dev/null
echo "wired_missing_iface=$(get_or_unset network.mesh_wired)"
echo "wired_missing_ports=$(get_or_unset 'network.@device[0].ports')"

# 19. An unsafe port name is refused.
reset_cfg
uci set meshassistant.config.wired_backhaul='lan3;reboot'
create_batman_network >/dev/null
echo "wired_unsafe_iface=$(get_or_unset network.mesh_wired)"
echo "wired_unsafe_ports=$(get_or_unset 'network.@device[0].ports')"

# 20. A port that is already dedicated (and no longer in the bridge) is
#     accepted on reapply and is not added back on disable.
reset_cfg
uci set 'network.@device[0].ports=lan2'
uci set network.mesh_wired=interface
uci set network.mesh_wired.device=lan3
uci set meshassistant.config.wired_backhaul=lan3
create_batman_network >/dev/null
echo "wired_readopt_device=$(get_or_unset network.mesh_wired.device)"
echo "wired_readopt_ports=$(get_or_unset 'network.@device[0].ports')"
echo "wired_readopt_removed=$(get_or_unset meshassistant.config.wired_backhaul_bridge_removed)"
disable_meshassistant >/dev/null
echo "wired_readopt_after_ports=$(get_or_unset 'network.@device[0].ports')"
echo "wired_readopt_after_iface=$(get_or_unset network.mesh_wired)"

# 21. link_info reports the hardif frequency and the peer signal.  A wired
#     hardif has neither, and iw failures must not add output.
batctl() {
	case "$*" in
		"meshif bat0 interface") printf 'mesh_radio0: active\nmesh_radio1: active\nmesh_wired: active\n' ;;
		*) return 1 ;;
	esac
}
iw() {
	case "$*" in
		"dev mesh_radio0 info")
			printf 'Interface mesh_radio0\n\tchannel 6 (2437 MHz), width: 40 MHz\n'
			;;
		"dev mesh_radio1 info")
			printf 'Interface mesh_radio1\n\tchannel 149 (5745 MHz)\n'
			;;
		"dev mesh_radio0 station dump")
			printf 'Station aa:bb:cc:dd:ee:ff (on mesh_radio0)\n'
			printf '\tinactive time:\t10 ms\n'
			printf '\tsignal:  \t-52 [-60, -55] dBm\n'
			printf '\tsignal avg:\t-53 dBm\n'
			;;
		"dev mesh_radio0 survey dump")
			printf '\tfrequency:\t\t2437 MHz [in use]\n'
			printf '\tnoise:\t\t\t-96 dBm\n'
			printf '\tchannel active time:\t\t1000 ms\n'
			printf '\tchannel busy time:\t\t250 ms\n'
			;;
		*) return 1 ;;
	esac
}
hardif_is_wireless() {
	case "$1" in
		mesh_radio*) return 0 ;;
		*) return 1 ;;
	esac
}
# The local hardif MAC is read from sysfs; mock the one path link_info reads.
cat() {
	case "$1" in
		/sys/class/net/mesh_radio0/address) printf 'aa:bb:cc:dd:ee:ff\n'; return 0 ;;
	esac
	command cat "$@"
}
echo "link_iface=$(link_info | awk '$1 == "iface" && $2 == "mesh_radio0" { print $3 }')"
echo "link_channel=$(link_info | awk '$1 == "iface" && $2 == "mesh_radio0" { print $4 }')"
echo "link_width=$(link_info | awk '$1 == "iface" && $2 == "mesh_radio0" { print $5 }')"
echo "link_legacy=$(link_info | sed -n 's/^iface mesh_radio1 //p')"
echo "link_busy=$(link_info | sed -n 's/^busy mesh_radio0 //p')"
echo "link_peer=$(link_info | sed -n 's/^peer mesh_radio0 aa:bb:cc:dd:ee:ff //p')"
echo "link_wired=$(link_info | grep -v '^kind ' | grep -c 'mesh_wired')"
echo "link_kind_wlan=$(link_info | awk '$1 == "kind" && $2 == "mesh_radio0" { print $3 }')"
echo "link_kind_mac=$(link_info | awk '$1 == "kind" && $2 == "mesh_radio0" { print $4 }')"
echo "link_kind_wired=$(link_info | awk '$1 == "kind" && $2 == "mesh_wired" { print $3 }')"
echo "link_kind_noiw=$( ( unset -f iw; link_info ) | awk '$1 == "kind" && $2 == "mesh_radio0" { print $3 }')"
echo "link_iface_noiw=$( ( unset -f iw; link_info ) | grep -c '^iface ')"
echo "link_local_hostname=$(link_info | awk '$1 == "local" { print $2 }')"
echo "link_local_fields=$(link_info | awk '$1 == "local" { print NF }')"
uci set meshassistant.config.role=client
echo "link_local_role=$(link_info | awk '$1 == "local" { print $5 }')"
uci del meshassistant.config.role
echo "link_local_default_role=$(link_info | awk '$1 == "local" { print $5 }')"
unset -f cat

# The clear-log action empties the run log while keeping the file readable.
printf 'old run log\n' > "$TEST_INITD_STATE/run.log"
MESHASSISTANT_LOG="$TEST_INITD_STATE/run.log"
clear_log
echo "log_after_clear=$(wc -c < "$TEST_INITD_STATE/run.log" | tr -d ' ')"

# 22. Peer announcements: version 2 carries the load, version 3 adds the LAN
#     MAC, version 4 adds the backhaul state of the hardif, version 5 adds its
#     medium, version 6 adds the rate batman measures on it, version 7 adds its
#     name, and version 1 is still accepted without any of them.  Unknown
#     versions are ignored.  A datagram may carry several versions; an older
#     receiver reads only what it understands and keeps working.
MESHASSISTANT_PEERS="$TEST_INITD_STATE/peers"
: > "$MESHASSISTANT_PEERS"
printf 'meshassistant/2 aa:bb:cc:dd:ee:ff 192.168.10.50 nodeX 0.42\n' | record_peer
echo "peer_v2=$(tail -n 1 "$MESHASSISTANT_PEERS" | cut -d' ' -f2-)"
printf 'meshassistant/1 aa:bb:cc:dd:ee:ff 192.168.10.51 nodeY\n' | record_peer
echo "peer_v1=$(tail -n 1 "$MESHASSISTANT_PEERS" | cut -d' ' -f2-)"
printf 'meshassistant/3 22:33:44:55:66:77 aa:bb:cc:dd:ee:ff 192.168.10.52 nodeZ 0.10\n' | record_peer
echo "peer_v3=$(tail -n 1 "$MESHASSISTANT_PEERS" | cut -d' ' -f2-)"
printf 'meshassistant/3 22:33:44:55:66:77 not-a-mac 192.168.10.54 nodeW 0.20\n' | record_peer
echo "peer_badlanmac=$(tail -n 1 "$MESHASSISTANT_PEERS" | cut -d' ' -f6)"
printf 'meshassistant/9 aa:bb:cc:dd:ee:ff 192.168.10.55 nodeV 0.10\n' | record_peer
echo "peer_unknown_lines=$(wc -l < "$MESHASSISTANT_PEERS")"
printf 'meshassistant/4 22:33:44:55:66:77 aa:bb:cc:dd:ee:ff 192.168.10.57 nodeU 0.10 inuse\n' | record_peer
echo "peer_v4=$(tail -n 1 "$MESHASSISTANT_PEERS" | cut -d' ' -f2-)"
printf 'meshassistant/4 22:33:44:55:66:77 - 192.168.10.58 nodeT 0.20 standby\n' | record_peer
echo "peer_v4_nolan=$(tail -n 1 "$MESHASSISTANT_PEERS" | cut -d' ' -f2-)"
printf 'meshassistant/4 22:33:44:55:66:77 aa:bb:cc:dd:ee:ff 192.168.10.59 nodeS 0.30 bogus\n' | record_peer
echo "peer_v4_badstate=$(tail -n 1 "$MESHASSISTANT_PEERS" | cut -d' ' -f7)"
printf 'meshassistant/4 22:33:44:55:66:77 aa:bb:cc:dd:ee:ff 192.168.10.60 nodeR\n' | record_peer
echo "peer_v4_short=$(tail -n 1 "$MESHASSISTANT_PEERS" | cut -d' ' -f2-)"
printf 'meshassistant/5 22:33:44:55:66:77 aa:bb:cc:dd:ee:ff 192.168.10.63 nodeQ 0.10 inuse wired\n' | record_peer
echo "peer_v5=$(tail -n 1 "$MESHASSISTANT_PEERS" | cut -d' ' -f2-)"
printf 'meshassistant/5 22:33:44:55:66:77 - 192.168.10.64 nodeP 0.20 standby wlan\n' | record_peer
echo "peer_v5_nolan=$(tail -n 1 "$MESHASSISTANT_PEERS" | cut -d' ' -f2-)"
printf 'meshassistant/5 22:33:44:55:66:77 aa:bb:cc:dd:ee:ff 192.168.10.65 nodeO 0.10 inuse bogus\n' | record_peer
echo "peer_v5_badkind=$(tail -n 1 "$MESHASSISTANT_PEERS" | cut -d' ' -f8)"
peer_lines_before=$(wc -l < "$MESHASSISTANT_PEERS")
printf 'meshassistant/5 22:33:44:55:66:77 aa:bb:cc:dd:ee:ff 192.168.10.66 nodeN 0.10 inuse\n' | record_peer
echo "peer_v5_short=$(( $(wc -l < "$MESHASSISTANT_PEERS") - peer_lines_before ))"; unset peer_lines_before
printf 'meshassistant/6 22:33:44:55:66:77 aa:bb:cc:dd:ee:ff 192.168.10.67 nodeM 0.10 inuse wired 100000.0\n' | record_peer
echo "peer_v6=$(tail -n 1 "$MESHASSISTANT_PEERS" | cut -d' ' -f2-)"
printf 'meshassistant/6 22:33:44:55:66:77 - 192.168.10.68 nodeL 0.20 standby wlan -\n' | record_peer
echo "peer_v6_nospeed=$(tail -n 1 "$MESHASSISTANT_PEERS" | cut -d' ' -f2-)"
printf 'meshassistant/6 22:33:44:55:66:77 aa:bb:cc:dd:ee:ff 192.168.10.69 nodeK 0.10 inuse wired 1.2.3\n' | record_peer
echo "peer_v6_badspeed=$(tail -n 1 "$MESHASSISTANT_PEERS" | cut -d' ' -f9)"
peer_lines_before=$(wc -l < "$MESHASSISTANT_PEERS")
printf 'meshassistant/6 22:33:44:55:66:77 aa:bb:cc:dd:ee:ff 192.168.10.70 nodeJ 0.10 inuse wired\n' | record_peer
echo "peer_v6_short=$(( $(wc -l < "$MESHASSISTANT_PEERS") - peer_lines_before ))"; unset peer_lines_before
printf 'meshassistant/7 22:33:44:55:66:77 aa:bb:cc:dd:ee:ff 192.168.10.71 nodeI 0.10 inuse wired 100000.0 lan2\n' | record_peer
echo "peer_v7=$(tail -n 1 "$MESHASSISTANT_PEERS" | cut -d' ' -f2-)"
printf 'meshassistant/7 22:33:44:55:66:77 aa:bb:cc:dd:ee:ff 192.168.10.72 nodeH 0.10 inuse wired 100000.0 -\n' | record_peer
echo "peer_v7_noiface=$(tail -n 1 "$MESHASSISTANT_PEERS" | cut -d' ' -f10)"
printf 'meshassistant/7 22:33:44:55:66:77 aa:bb:cc:dd:ee:ff 192.168.10.73 nodeG 0.10 inuse wired 100000.0 bad/name\n' | record_peer
echo "peer_v7_badiface=$(tail -n 1 "$MESHASSISTANT_PEERS" | cut -d' ' -f10)"
printf 'meshassistant/7 22:33:44:55:66:77 aa:bb:cc:dd:ee:ff 192.168.10.74 nodeF 0.10 inuse wired 100000.0 a-very-long-iface\n' | record_peer
echo "peer_v7_longiface=$(tail -n 1 "$MESHASSISTANT_PEERS" | cut -d' ' -f10)"
peer_lines_before=$(wc -l < "$MESHASSISTANT_PEERS")
printf 'meshassistant/7 22:33:44:55:66:77 aa:bb:cc:dd:ee:ff 192.168.10.75 nodeE 0.10 inuse wired\n' | record_peer
echo "peer_v7_short=$(( $(wc -l < "$MESHASSISTANT_PEERS") - peer_lines_before ))"; unset peer_lines_before
printf 'meshassistant/2 aa:bb:cc:dd:ee:ff 192.168.10.53 nodeZ 1.2.3\n' | record_peer
echo "peer_badload=$(tail -n 1 "$MESHASSISTANT_PEERS" | cut -d' ' -f5)"
printf 'meshassistant/2 aa:bb:cc:dd:ee:ff 192.168.10.56 nodeD 0.30\nmeshassistant/3 aa:bb:cc:dd:ee:ff 11:22:33:44:55:66 192.168.10.56 nodeD 0.30\n' | record_peer
echo "peer_dual_v2=$(tail -n 2 "$MESHASSISTANT_PEERS" | head -n 1 | cut -d' ' -f3-5)"
echo "peer_dual_v3=$(tail -n 1 "$MESHASSISTANT_PEERS" | cut -d' ' -f6)"

# 22a. Concurrent announcements: socat forks one peer process per datagram, so
#      several record_peer runs append to the file at the same time.  Every
#      stored line must still be complete, with nothing lost or duplicated.
MESHASSISTANT_PEERS="$TEST_INITD_STATE/peers_concurrent"
: > "$MESHASSISTANT_PEERS"
concurrent_pids=''
for i in 1 2 3 4 5 6 7 8; do
    (
        j=0
        while [ "$j" -lt 25 ]; do
            printf 'meshassistant/3 aa:bb:cc:dd:ee:ff 11:22:33:44:55:66 192.168.10.%s node%s 0.10\n' "$i" "$i" | record_peer
            j=$((j + 1))
        done
    ) &
    concurrent_pids="$concurrent_pids $!"
done
wait $concurrent_pids
echo "peer_concurrent_lines=$(wc -l < "$MESHASSISTANT_PEERS")"
echo "peer_concurrent_bad=$(awk 'NF != 6 || $1 !~ /^[0-9]+$/ { bad++ } END { print bad + 0 }' "$MESHASSISTANT_PEERS")"
echo "peer_concurrent_distinct=$(awk '{ print $2, $3, $4, $5, $6 }' "$MESHASSISTANT_PEERS" | sort -u | wc -l)"

# 22b. Pruning keeps only fresh announcements, and a damaged line whose first
#      field is not a past timestamp must go too; otherwise it would count as
#      fresh forever and never be pruned.
MESHASSISTANT_PEERS="$TEST_INITD_STATE/peers_prune"
now=$(date +%s)
{
    printf '%s aa:bb:cc:dd:ee:ff 192.168.10.70 expired 0.10 -\n' "$((now - 600))"
    printf '%s aa:bb:cc:dd:ee:ff 192.168.10.71 fresh 0.10 -\n' "$now"
    printf '17939726741793972674 17939726741234567890 aa:bb:cc:dd:ee:ff11:22:33:44:55:66 192.168.10.72192.168.10.72  node 0.1 0.2  -\n'
} > "$MESHASSISTANT_PEERS"
prune_peers
echo "peer_prune_lines=$(wc -l < "$MESHASSISTANT_PEERS")"
echo "peer_prune_kept=$(cut -d' ' -f3 "$MESHASSISTANT_PEERS")"

# 22b2. Client names: local_names prints the lease file and the static host
#       reservations (the reservation after the lease, so it wins), skips a
#       lease without a hostname and accepts a reservation without an address.
: > "$MESHASSISTANT_NAMES"
{
    printf '%s aa:bb:cc:dd:ee:01 192.168.10.101 lease-one *\n' 1750000000
    printf '%s aa:bb:cc:dd:ee:02 192.168.10.102 short-name *\n' 0
    printf '%s aa:bb:cc:dd:ee:03 192.168.10.103 * *\n' 1750000000
} > "$MESHASSISTANT_LEASES"
uci set 'dhcp.@host[0]'=host
uci set 'dhcp.@host[0].name'=static-two
uci set 'dhcp.@host[0].mac'='AA:BB:CC:DD:EE:02'
uci set 'dhcp.@host[0].ip'='192.168.10.102'
uci set 'dhcp.@host[1]'=host
uci set 'dhcp.@host[1].name'=static-four
uci set 'dhcp.@host[1].mac'='aa:bb:cc:dd:ee:04'
echo "names_local=$(local_names | tr '\n' '|')"

# A version 8 announcement is stored in the name table, never in the peer
# file, and its fields are sanitized like the peer fields.
peer_lines_before=$(wc -l < "$MESHASSISTANT_PEERS")
printf 'meshassistant/8 aa:bb:cc:dd:ee:05 192.168.10.105 client-five\n' | record_peer
echo "names_record=$(tail -n 1 "$MESHASSISTANT_NAMES" | cut -d' ' -f2-)"
printf 'meshassistant/8 aa:bb:cc:dd:ee:06 bad;ip cli;ent\n' | record_peer
echo "names_record_sanitized=$(tail -n 1 "$MESHASSISTANT_NAMES" | cut -d' ' -f2-)"
names_before=$(wc -l < "$MESHASSISTANT_NAMES")
printf 'meshassistant/8 not-a-mac - bad\n' | record_peer
echo "names_record_badmac=$(( $(wc -l < "$MESHASSISTANT_NAMES") - names_before ))"; unset names_before
echo "names_peer_untouched=$(( $(wc -l < "$MESHASSISTANT_PEERS") - peer_lines_before ))"; unset peer_lines_before

# Expired name entries are pruned like peer announcements.
now=$(date +%s)
{
    printf '%s aa:bb:cc:dd:ee:08 192.168.10.108 expired\n' "$((now - 600))"
    printf '%s aa:bb:cc:dd:ee:09 192.168.10.109 fresh\n' "$now"
} > "$MESHASSISTANT_NAMES"
prune_names
echo "names_prune=$(cut -d' ' -f2 "$MESHASSISTANT_NAMES")"

# The table is broadcast as version 8 lines, one datagram; an empty table
# sends nothing.
reset_cfg
printf '0 aa:bb:cc:dd:ee:10 192.168.10.110 host-ten *\n' > "$MESHASSISTANT_LEASES"
lan_broadcast() { printf '192.168.10.255\n'; }
socat() { cat >> "$TEST_INITD_STATE/names_announce.txt"; }
: > "$TEST_INITD_STATE/names_announce.txt"
announce_names
echo "names_announce=$(cat "$TEST_INITD_STATE/names_announce.txt")"
: > "$MESHASSISTANT_LEASES"
: > "$TEST_INITD_STATE/names_announce.txt"
announce_names
echo "names_announce_empty=$(wc -c < "$TEST_INITD_STATE/names_announce.txt")"

# 22c. An announcement sends the v2 line first (older peers read only that
#      line), a v3 line carrying the LAN MAC when it is known and a v4 line
#      carrying the backhaul state of the announced hardif.  The real
#      lan_hwaddr runs in a subshell with a mocked sysfs read, so the source
#      functions stay intact for the rest of the harness.
echo "lan_hwaddr_real=$( ( lan_device() { printf 'br-lan\n'; }; cat() { printf 'AA:BB:CC:DD:EE:FF\n'; }; lan_hwaddr ) )"
socat() { cat >> "$TEST_INITD_STATE/announce.txt"; }
lan_ipv4() { printf '192.168.10.2\n'; }
lan_broadcast() { printf '192.168.10.255\n'; }
mesh_hardif_bindings() { printf 'mesh_radio2 22:33:44:55:66:77 wlan\n'; }
mesh_selected_ifaces() { printf 'mesh_radio2\n'; }
# The real mesh_hardif_speeds runs against this neighbor table: the announced
# hardif carries the best speed batman measured on it.
batctl() {
    case "$*" in
        "meshif bat0 neighbors")
            printf '00:58:28:22:67:fc    0.490s (     1903.4) [mesh_radio2]\n'
            printf '00:58:28:12:81:54    0.210s (     1500.0) [mesh_radio2]\n'
            printf '00:58:28:12:81:50    0.050s (   100000.0) [      lan2]\n'
            ;;
        *) return 1 ;;
    esac
}
lan_hwaddr() { printf 'aa:bb:cc:dd:ee:ff\n'; }
: > "$TEST_INITD_STATE/announce.txt"
announce_identity
echo "announce_lines=$(wc -l < "$TEST_INITD_STATE/announce.txt")"
echo "announce_v2_proto=$(awk 'NR == 1 { print $1 }' "$TEST_INITD_STATE/announce.txt")"
echo "announce_v2_mac=$(awk 'NR == 1 { print $2 }' "$TEST_INITD_STATE/announce.txt")"
echo "announce_v2_ip=$(awk 'NR == 1 { print $3 }' "$TEST_INITD_STATE/announce.txt")"
echo "announce_v3_proto=$(awk 'NR == 2 { print $1 }' "$TEST_INITD_STATE/announce.txt")"
echo "announce_v3_mac=$(awk 'NR == 2 { print $2 }' "$TEST_INITD_STATE/announce.txt")"
echo "announce_v3_lanmac=$(awk 'NR == 2 { print $3 }' "$TEST_INITD_STATE/announce.txt")"
echo "announce_v3_ip=$(awk 'NR == 2 { print $4 }' "$TEST_INITD_STATE/announce.txt")"
echo "announce_v4_proto=$(awk 'NR == 3 { print $1 }' "$TEST_INITD_STATE/announce.txt")"
echo "announce_v4_mac=$(awk 'NR == 3 { print $2 }' "$TEST_INITD_STATE/announce.txt")"
echo "announce_v4_lanmac=$(awk 'NR == 3 { print $3 }' "$TEST_INITD_STATE/announce.txt")"
echo "announce_v4_ip=$(awk 'NR == 3 { print $4 }' "$TEST_INITD_STATE/announce.txt")"
echo "announce_v4_state=$(awk 'NR == 3 { print $7 }' "$TEST_INITD_STATE/announce.txt")"
echo "announce_v5_proto=$(awk 'NR == 4 { print $1 }' "$TEST_INITD_STATE/announce.txt")"
echo "announce_v5_mac=$(awk 'NR == 4 { print $2 }' "$TEST_INITD_STATE/announce.txt")"
echo "announce_v5_lanmac=$(awk 'NR == 4 { print $3 }' "$TEST_INITD_STATE/announce.txt")"
echo "announce_v5_ip=$(awk 'NR == 4 { print $4 }' "$TEST_INITD_STATE/announce.txt")"
echo "announce_v5_state=$(awk 'NR == 4 { print $7 }' "$TEST_INITD_STATE/announce.txt")"
echo "announce_v5_kind=$(awk 'NR == 4 { print $8 }' "$TEST_INITD_STATE/announce.txt")"
echo "announce_v6_proto=$(awk 'NR == 5 { print $1 }' "$TEST_INITD_STATE/announce.txt")"
echo "announce_v6_mac=$(awk 'NR == 5 { print $2 }' "$TEST_INITD_STATE/announce.txt")"
echo "announce_v6_lanmac=$(awk 'NR == 5 { print $3 }' "$TEST_INITD_STATE/announce.txt")"
echo "announce_v6_ip=$(awk 'NR == 5 { print $4 }' "$TEST_INITD_STATE/announce.txt")"
echo "announce_v6_state=$(awk 'NR == 5 { print $7 }' "$TEST_INITD_STATE/announce.txt")"
echo "announce_v6_kind=$(awk 'NR == 5 { print $8 }' "$TEST_INITD_STATE/announce.txt")"
echo "announce_v6_speed=$(awk 'NR == 5 { print $9 }' "$TEST_INITD_STATE/announce.txt")"
echo "announce_v7_proto=$(awk 'NR == 6 { print $1 }' "$TEST_INITD_STATE/announce.txt")"
echo "announce_v7_mac=$(awk 'NR == 6 { print $2 }' "$TEST_INITD_STATE/announce.txt")"
echo "announce_v7_lanmac=$(awk 'NR == 6 { print $3 }' "$TEST_INITD_STATE/announce.txt")"
echo "announce_v7_ip=$(awk 'NR == 6 { print $4 }' "$TEST_INITD_STATE/announce.txt")"
echo "announce_v7_state=$(awk 'NR == 6 { print $7 }' "$TEST_INITD_STATE/announce.txt")"
echo "announce_v7_kind=$(awk 'NR == 6 { print $8 }' "$TEST_INITD_STATE/announce.txt")"
echo "announce_v7_speed=$(awk 'NR == 6 { print $9 }' "$TEST_INITD_STATE/announce.txt")"
echo "announce_v7_iface=$(awk 'NR == 6 { print $10 }' "$TEST_INITD_STATE/announce.txt")"
: > "$TEST_INITD_STATE/announce.txt"
mesh_selected_ifaces() { printf 'lan2\n'; }
announce_identity
echo "announce_standby_state=$(awk 'NR == 3 { print $7 }' "$TEST_INITD_STATE/announce.txt")"
: > "$TEST_INITD_STATE/announce.txt"
mesh_selected_ifaces() { :; }
announce_identity
echo "announce_unknown_state=$(awk 'NR == 3 { print $7 }' "$TEST_INITD_STATE/announce.txt")"
: > "$TEST_INITD_STATE/announce.txt"
lan_hwaddr() { :; }
announce_identity
echo "announce_no_lanmac_lines=$(wc -l < "$TEST_INITD_STATE/announce.txt")"
echo "announce_no_lanmac_v4_lanmac=$(awk 'NR == 2 { print $3 }' "$TEST_INITD_STATE/announce.txt")"

# 22d. The version 5 line carries the medium of the hardif, so a receiver that
#      is not a direct neighbor of it can still label the row.  A hardif whose
#      medium is unknown is announced with a placeholder.
: > "$TEST_INITD_STATE/announce.txt"
mesh_hardif_bindings() { printf 'lan2 33:44:55:66:77:88 wired\n'; }
announce_identity
echo "announce_wired_kind=$(awk 'NR == 3 { print $8 }' "$TEST_INITD_STATE/announce.txt")"
echo "announce_wired_speed=$(awk 'NR == 4 { print $9 }' "$TEST_INITD_STATE/announce.txt")"
echo "announce_wired_iface=$(awk 'NR == 5 { print $10 }' "$TEST_INITD_STATE/announce.txt")"
: > "$TEST_INITD_STATE/announce.txt"
mesh_hardif_bindings() { printf 'lan2 33:44:55:66:77:88\n'; }
announce_identity
echo "announce_unknown_kind=$(awk 'NR == 3 { print $8 }' "$TEST_INITD_STATE/announce.txt")"

# 22e. A hardif with no direct neighbor has no rate to report; the version 6
#      line marks it with a placeholder instead of inventing one.
: > "$TEST_INITD_STATE/announce.txt"
mesh_hardif_bindings() { printf 'mesh_radio9 44:55:66:77:88:99 wlan\n'; }
announce_identity
echo "announce_no_neighbor_speed=$(awk 'NR == 4 { print $9 }' "$TEST_INITD_STATE/announce.txt")"
echo "announce_no_neighbor_iface=$(awk 'NR == 5 { print $10 }' "$TEST_INITD_STATE/announce.txt")"

# 23. Spectrum settings are applied to both the Mesh radio and the regular AP
#     radios.  Values are combined into one htmode and empty fields are left
#     alone.
reset_cfg
AP_RADIO=radio0
uci set wireless.radio0.band=2g
uci set wireless.radio0.htmode=HT40
uci set wireless.radio0.channel=6
uci set wireless.radio0.txpower=20
uci set wireless.radio0.country=US
uci set wireless.radio1.band=5g
uci set wireless.radio1.htmode=HE80
uci set wireless.radio1.channel=36
uci set wireless.radio1.txpower=20
uci set wireless.radio1.country=US
uci set meshassistant.config.spectrum_radio0_country=TW
uci set meshassistant.config.spectrum_radio0_channel=11
uci set meshassistant.config.spectrum_radio0_mode=EHT
uci set meshassistant.config.spectrum_radio0_width=40
uci set meshassistant.config.spectrum_radio0_txpower=25
uci set meshassistant.config.spectrum_radio1_country=DE
uci set meshassistant.config.spectrum_radio1_channel=auto
uci set meshassistant.config.spectrum_radio1_mode=VHT
uci set meshassistant.config.spectrum_radio1_width=160
uci set meshassistant.config.spectrum_radio1_txpower=30
apply_spectrum_settings >/dev/null
echo "spectrum_ap_country=$(get_or_unset wireless.radio0.country)"
echo "spectrum_ap_channel=$(get_or_unset wireless.radio0.channel)"
echo "spectrum_ap_htmode=$(get_or_unset wireless.radio0.htmode)"
echo "spectrum_ap_txpower=$(get_or_unset wireless.radio0.txpower)"
echo "spectrum_mesh_country=$(get_or_unset wireless.radio1.country)"
echo "spectrum_mesh_channel=$(get_or_unset wireless.radio1.channel)"
echo "spectrum_mesh_htmode=$(get_or_unset wireless.radio1.htmode)"
echo "spectrum_mesh_txpower=$(get_or_unset wireless.radio1.txpower)"

# 24. Empty spectrum fields never touch the radio.
reset_cfg
AP_RADIO=radio0
uci set wireless.radio0.band=2g
uci set wireless.radio0.htmode=HT40
uci set wireless.radio0.channel=6
uci set wireless.radio0.country=US
uci set wireless.radio1.band=5g
uci set wireless.radio1.htmode=HE80
uci set wireless.radio1.channel=36
uci set wireless.radio1.country=US
apply_spectrum_settings >/dev/null
echo "spectrum_empty_channel=$(get_or_unset wireless.radio0.channel)"
echo "spectrum_empty_htmode=$(get_or_unset wireless.radio0.htmode)"
echo "spectrum_empty_country=$(get_or_unset wireless.radio0.country)"
echo "spectrum_empty_mesh_htmode=$(get_or_unset wireless.radio1.htmode)"

# 25. An invalid mode/width pair is rejected; a single missing part is taken
#     from the current htmode.
reset_cfg
AP_RADIO=radio0
uci set wireless.radio0.band=2g
uci set wireless.radio0.htmode=HT40
uci set meshassistant.config.spectrum_radio0_mode=HT
uci set meshassistant.config.spectrum_radio0_width=80
apply_spectrum_settings >/dev/null
echo "spectrum_bad_pair=$(get_or_unset wireless.radio0.htmode)"
uci set meshassistant.config.spectrum_radio0_mode=EHT
uci set meshassistant.config.spectrum_radio0_width=
apply_spectrum_settings >/dev/null
echo "spectrum_mode_only=$(get_or_unset wireless.radio0.htmode)"
uci set meshassistant.config.spectrum_radio0_mode=
uci set meshassistant.config.spectrum_radio0_width=80
apply_spectrum_settings >/dev/null
echo "spectrum_width_only=$(get_or_unset wireless.radio0.htmode)"

reset_cfg
AP_RADIO=radio0
uci set wireless.radio0.band=6g
uci set wireless.radio0.htmode=EHT160
uci set meshassistant.config.spectrum_radio0_width=320
apply_spectrum_settings >/dev/null
echo "spectrum_width_6g=$(get_or_unset wireless.radio0.htmode)"

reset_cfg
AP_RADIO=radio0
uci set wireless.radio0.band=5g
uci set wireless.radio0.htmode=EHT160
uci set meshassistant.config.spectrum_radio0_width=320
apply_spectrum_settings >/dev/null
echo "spectrum_width_5g_320=$(get_or_unset wireless.radio0.htmode)"

# 26. Invalid country, channel and transmit power are ignored.
reset_cfg
AP_RADIO=radio0
uci set wireless.radio0.band=2g
uci set wireless.radio0.channel=6
uci set wireless.radio0.txpower=20
uci set wireless.radio0.country=US
uci set meshassistant.config.spectrum_radio0_country=tw
uci set meshassistant.config.spectrum_radio0_channel=6x
uci set meshassistant.config.spectrum_radio0_txpower=41
apply_spectrum_settings >/dev/null
echo "spectrum_bad_country=$(get_or_unset wireless.radio0.country)"
echo "spectrum_bad_channel=$(get_or_unset wireless.radio0.channel)"
echo "spectrum_bad_txpower=$(get_or_unset wireless.radio0.txpower)"

# 27. A 5 GHz MLO radio on a DFS channel keeps the channel but warns.
reset_cfg
AP_RADIO=radio0
uci set wireless.radio0.band=2g
uci set wireless.radio1.band=5g
uci set meshassistant.config.wifi_radio='radio1'
uci set meshassistant.config.mlo=1
uci set meshassistant.config.spectrum_radio1_channel=100
apply_spectrum_settings > "$TEST_INITD_STATE/spectrum.log"
echo "spectrum_dfs_warning=$(grep -c 'DFS channel 100' "$TEST_INITD_STATE/spectrum.log")"
echo "spectrum_dfs_channel=$(get_or_unset wireless.radio1.channel)"

# 28. An empty netmask must never be written: netifd would apply the address
#     as /32 and the node would become unreachable while still answering ARP.
#     The previous LAN configuration must stay untouched.
reset_cfg
uci set meshassistant.config.role=off
uci set meshassistant.config.ipmode=static
uci set meshassistant.config.ipaddr=192.168.10.112
uci set meshassistant.config.netmask=
uci set meshassistant.config.gateway=192.168.10.1
no_mask_output=$( ( create_batman_network ) 2>&1 )
echo "lan_empty_mask_proto=$(get_or_unset network.lan.proto)"
echo "lan_empty_mask_ip=$(get_or_unset network.lan.ipaddr)"
echo "lan_empty_mask_netmask=$(get_or_unset network.lan.netmask)"
echo "lan_empty_mask_gateway=$(get_or_unset network.lan.gateway)"
echo "lan_empty_mask_state=$([ -f "$MESHASSISTANT_LAN_STATE" ] && echo yes || echo no)"
echo "lan_empty_mask_warning=$(printf '%s' "$no_mask_output" | grep -c 'would apply the address as /32')"

# 29. A netmask that is not contiguous is refused as well.
reset_cfg
uci set meshassistant.config.role=off
uci set meshassistant.config.ipmode=static
uci set meshassistant.config.ipaddr=192.168.10.112
uci set meshassistant.config.netmask=255.0.255.0
bad_mask_output=$( ( create_batman_network ) 2>&1 )
echo "lan_bad_mask_ip=$(get_or_unset network.lan.ipaddr)"
echo "lan_bad_mask_netmask=$(get_or_unset network.lan.netmask)"
echo "lan_bad_mask_warning=$(printf '%s' "$bad_mask_output" | grep -c 'is not a valid netmask')"

# 30. An empty or malformed static address is refused before anything is
#     written.
reset_cfg
uci set meshassistant.config.role=off
uci set meshassistant.config.ipmode=static
uci set meshassistant.config.ipaddr=
uci set meshassistant.config.netmask=255.255.255.0
empty_ip_output=$( ( create_batman_network ) 2>&1 )
echo "lan_empty_ip_netmask=$(get_or_unset network.lan.netmask)"
echo "lan_empty_ip_warning=$(printf '%s' "$empty_ip_output" | grep -c "'Static IP Address' is empty")"

reset_cfg
uci set meshassistant.config.role=off
uci set meshassistant.config.ipmode=static
uci set meshassistant.config.ipaddr=192.168.010.4
uci set meshassistant.config.netmask=255.255.255.0
bad_ip_output=$( ( create_batman_network ) 2>&1 )
echo "lan_bad_ip_netmask=$(get_or_unset network.lan.netmask)"
echo "lan_bad_ip_warning=$(printf '%s' "$bad_ip_output" | grep -c 'is not a valid IPv4 address')"

# 31. A valid static configuration is still written, and the expected address
#     is recorded for the post-reload check.
reset_cfg
uci set meshassistant.config.role=off
uci set meshassistant.config.ipmode=static
uci set meshassistant.config.ipaddr=192.168.10.112
uci set meshassistant.config.netmask=255.255.255.0
uci set meshassistant.config.gateway=192.168.10.1
create_batman_network > /dev/null
echo "lan_static_ip=$(get_or_unset network.lan.ipaddr)"
echo "lan_static_netmask=$(get_or_unset network.lan.netmask)"
echo "lan_static_expect_ip=$(sed -n 's/^expect_ip=//p' "$MESHASSISTANT_LAN_STATE")"
echo "lan_static_expect_mask=$(sed -n 's/^expect_netmask=//p' "$MESHASSISTANT_LAN_STATE")"
echo "lan_static_expect_gw=$(sed -n 's/^expect_gateway=//p' "$MESHASSISTANT_LAN_STATE")"

# 32. The address helpers reject unusable values.
echo "helper_ipv4_ok=$(valid_ipv4 192.168.10.4 && echo 1 || echo 0)"
echo "helper_ipv4_zero=$(valid_ipv4 0.0.0.0 && echo 1 || echo 0)"
echo "helper_ipv4_leading=$(valid_ipv4 192.168.010.4 && echo 1 || echo 0)"
echo "helper_ipv4_short=$(valid_ipv4 192.168.10 && echo 1 || echo 0)"
echo "helper_ipv4_high=$(valid_ipv4 256.1.1.1 && echo 1 || echo 0)"
echo "helper_ipv4_empty=$(valid_ipv4 '' && echo 1 || echo 0)"
echo "helper_mask_24=$(valid_netmask 255.255.255.0 && echo 1 || echo 0)"
echo "helper_mask_32=$(valid_netmask 255.255.255.255 && echo 1 || echo 0)"
echo "helper_mask_noncontig=$(valid_netmask 255.0.255.0 && echo 1 || echo 0)"
echo "helper_mask_zero=$(valid_netmask 0.0.0.0 && echo 1 || echo 0)"
echo "helper_mask_host=$(valid_netmask 255.255.255.1 && echo 1 || echo 0)"
echo "helper_prefix_24=$(netmask_prefix 255.255.255.0)"
echo "helper_prefix_8=$(netmask_prefix 255.0.0.0)"
echo "helper_prefix_32=$(netmask_prefix 255.255.255.255)"
echo "helper_prefix_30=$(netmask_prefix 255.255.255.252)"

# 33. When the applied address does not come up (netifd fell back to /32
#     without a mask), the post-reload check restores the previous LAN
#     options.
reset_cfg
uci set meshassistant.config.role=off
uci set meshassistant.config.ipmode=static
uci set meshassistant.config.ipaddr=192.168.10.112
uci set meshassistant.config.netmask=255.255.255.0
uci set meshassistant.config.gateway=192.168.10.1
create_batman_network > /dev/null
ip() {
	case "$*" in
		"-4 -o addr show dev br-lan") echo "2: br-lan    inet 192.168.10.112/32 brd 192.168.10.112 scope global br-lan" ;;
		"route show dev br-lan") : ;;
		*) return 1 ;;
	esac
}
lan_watchdog_check > "$TEST_INITD_STATE/rollback.log" 2>&1
echo "lan_rollback_rc=$?"
echo "lan_rollback_proto=$(get_or_unset network.lan.proto)"
echo "lan_rollback_ip=$(get_or_unset network.lan.ipaddr)"
echo "lan_rollback_netmask=$(get_or_unset network.lan.netmask)"
echo "lan_rollback_gateway=$(get_or_unset network.lan.gateway)"
echo "lan_rollback_state=$([ -f "$MESHASSISTANT_LAN_STATE" ] && echo yes || echo no)"
echo "lan_rollback_warning=$(grep -c 'restoring the previous LAN settings' "$TEST_INITD_STATE/rollback.log")"

# 34. A healthy static configuration is kept.
reset_cfg
uci set meshassistant.config.role=off
uci set meshassistant.config.ipmode=static
uci set meshassistant.config.ipaddr=192.168.10.112
uci set meshassistant.config.netmask=255.255.255.0
uci set meshassistant.config.gateway=192.168.10.1
create_batman_network > /dev/null
ip() {
	case "$*" in
		"-4 -o addr show dev br-lan") echo "2: br-lan    inet 192.168.10.112/24 brd 192.168.10.255 scope global br-lan" ;;
		"route show dev br-lan")
			printf 'default via 192.168.10.1 dev br-lan proto static\n'
			printf '192.168.10.0/24 dev br-lan proto kernel scope link src 192.168.10.112\n'
			;;
		*) return 1 ;;
	esac
}
lan_watchdog_check > "$TEST_INITD_STATE/healthy.log" 2>&1
echo "lan_healthy_rc=$?"
echo "lan_healthy_ip=$(get_or_unset network.lan.ipaddr)"
echo "lan_healthy_state=$([ -f "$MESHASSISTANT_LAN_STATE" ] && echo yes || echo no)"
echo "lan_healthy_message=$(grep -c 'Verified the LAN address 192.168.10.112/24' "$TEST_INITD_STATE/healthy.log")"

# 35. A missing gateway route is a failure even when the address is up.
reset_cfg
uci set meshassistant.config.role=off
uci set meshassistant.config.ipmode=static
uci set meshassistant.config.ipaddr=192.168.10.112
uci set meshassistant.config.netmask=255.255.255.0
uci set meshassistant.config.gateway=192.168.10.1
create_batman_network > /dev/null
ip() {
	case "$*" in
		"-4 -o addr show dev br-lan") echo "2: br-lan    inet 192.168.10.112/24 brd 192.168.10.255 scope global br-lan" ;;
		"route show dev br-lan") printf '192.168.10.0/24 dev br-lan proto kernel scope link src 192.168.10.112\n' ;;
		*) return 1 ;;
	esac
}
lan_watchdog_check > "$TEST_INITD_STATE/no-gw.log" 2>&1
echo "lan_no_gw_rc=$?"
echo "lan_no_gw_ip=$(get_or_unset network.lan.ipaddr)"
echo "lan_no_gw_warning=$(grep -c 'restoring the previous LAN settings' "$TEST_INITD_STATE/no-gw.log")"

# 36. Static node LAN: clearing the gateway and DNS fields must remove the
#     old values instead of leaving a stale default route or resolver.
reset_cfg
uci set meshassistant.config.role=off
uci set meshassistant.config.ipmode=static
uci set meshassistant.config.ipaddr=192.168.10.112
uci set meshassistant.config.netmask=255.255.255.0
uci set network.lan.gateway=192.168.10.1
uci set network.lan.dns='192.168.10.53 192.168.10.54'
create_batman_network >/dev/null
echo "static_clear_gateway=$(get_or_unset network.lan.gateway)"
echo "static_clear_dns=$(get_or_unset network.lan.dns)"

# 37. Dumb AP must restore only the services it disabled itself; a service
#     the administrator had already disabled stays off.
reset_cfg
seed_etc_config
rm -f "$TEST_INITD_STATE/firewall.enabled"
MESHASSISTANT_LAN_WATCHDOG=0 set_apmode >/dev/null 2>&1
echo "dumbap_fw_record=$(get_or_unset meshassistant.config.disabled_firewall)"
echo "dumbap_dns_record=$(get_or_unset meshassistant.config.disabled_dnsmasq)"
echo "dumbap_odhcpd_record=$(get_or_unset meshassistant.config.disabled_odhcpd)"
echo "dumbap_fw_state=$( [ -e "$TEST_INITD_STATE/firewall.enabled" ] && echo enabled || echo disabled )"
echo "dumbap_dns_state=$( [ -e "$TEST_INITD_STATE/dnsmasq.enabled" ] && echo enabled || echo disabled )"
disable_apmode >/dev/null 2>&1
echo "undumb_fw_state=$( [ -e "$TEST_INITD_STATE/firewall.enabled" ] && echo enabled || echo disabled )"
echo "undumb_dns_state=$( [ -e "$TEST_INITD_STATE/dnsmasq.enabled" ] && echo enabled || echo disabled )"
echo "undumb_dns_record=$(get_or_unset meshassistant.config.disabled_dnsmasq)"
echo "undumb_apmode=$(get_or_unset meshassistant.config.ap_mode_enabled)"

# 38. Re-applying Dumb AP must keep the original configuration snapshot:
#     the current files were already converted and would overwrite it.
reset_cfg
seed_etc_config
MESHASSISTANT_LAN_WATCHDOG=0 set_apmode >/dev/null 2>&1
printf 'converted network\n' > "$MESHASSISTANT_CONFIG_DIR/network"
MESHASSISTANT_LAN_WATCHDOG=0 set_apmode >/dev/null 2>&1
echo "dumbap_apmode=$(get_or_unset meshassistant.config.ap_mode_enabled)"
echo "dumbap_backup=$(cat "$MESHASSISTANT_CONFIG_DIR/network.meshbak")"

# 39. Dumb AP static mode follows the same rule: cleared gateway and DNS
#     fields must not keep the previous values.
reset_cfg
seed_etc_config
uci set meshassistant.config.ipmode=static
uci set meshassistant.config.ipaddr=192.168.10.112
uci set meshassistant.config.netmask=255.255.255.0
uci set network.lan.gateway=192.168.10.1
uci set network.lan.dns='192.168.10.53'
MESHASSISTANT_LAN_WATCHDOG=0 set_apmode >/dev/null 2>&1
echo "dumbap_static_gateway=$(get_or_unset network.lan.gateway)"
echo "dumbap_static_dns=$(get_or_unset network.lan.dns)"

# 40. Reverse DNS answers are cached, so repeated client listings do not ask
#     the DNS server for the same address again.
reset_cfg
mkdir -p "$TEST_INITD_STATE/bin"
cat > "$TEST_INITD_STATE/bin/nslookup" <<'FAKE'
#!/bin/sh
echo "$1" >> "$TEST_INITD_STATE/nslookup_calls"
printf 'name = client-%s.lan\n' "$1"
FAKE
chmod +x "$TEST_INITD_STATE/bin/nslookup"
PATH="$TEST_INITD_STATE/bin:$PATH"
echo "rdns_first=$(client_reverse_name 192.168.10.20 192.168.10.1)"
echo "rdns_second=$(client_reverse_name 192.168.10.20 192.168.10.1)"
echo "rdns_calls=$(wc -l < "$TEST_INITD_STATE/nslookup_calls" | tr -d ' ')"
echo "rdns_cached=$(grep -c ' 192.168.10.20 client-192.168.10.20$' "$MESHASSISTANT_RDNS_CACHE")"

# 41. An expired entry is looked up again instead of being used forever.
printf '1 192.168.10.30 stale-name\n' > "$MESHASSISTANT_RDNS_CACHE"
echo "rdns_expired=$(client_reverse_name 192.168.10.30 192.168.10.1)"
echo "rdns_expired_calls=$(wc -l < "$TEST_INITD_STATE/nslookup_calls" | tr -d ' ')"

# 42. A negative answer is cached too: an address the server does not know is
#     not looked up on every refresh.
cat > "$TEST_INITD_STATE/bin/nslookup" <<'FAKE'
#!/bin/sh
echo "$1" >> "$TEST_INITD_STATE/nslookup_calls"
exit 0
FAKE
echo "rdns_none_first=$(client_reverse_name 192.168.10.40 192.168.10.1)"
echo "rdns_none_second=$(client_reverse_name 192.168.10.40 192.168.10.1)"
echo "rdns_none_calls=$(wc -l < "$TEST_INITD_STATE/nslookup_calls" | tr -d ' ')"
echo "rdns_none_cached=$(grep -c ' 192.168.10.40 -$' "$MESHASSISTANT_RDNS_CACHE")"

# 43. Creating a backup keeps the backup directory bounded: only the newest
#     archives survive.
reset_cfg
seed_etc_config
mkdir -p "$MESHASSISTANT_BACKUP_DIR"
for i in $(seq -w 1 25); do
    : > "$MESHASSISTANT_BACKUP_DIR/20240101-0000$i.tar"
done
created=$(backup_create | sed -n 's/^Created backup: //p')
echo "backup_created_exists=$( [ -f "$created" ] && echo yes || echo no )"
echo "backup_count=$(find "$MESHASSISTANT_BACKUP_DIR" -maxdepth 1 -name '*.tar' | wc -l | tr -d ' ')"
echo "backup_oldest_kept=$( [ -e "$MESHASSISTANT_BACKUP_DIR/20240101-000007.tar" ] && echo yes || echo no )"
echo "backup_oldest_gone=$( [ -e "$MESHASSISTANT_BACKUP_DIR/20240101-000001.tar" ] && echo no || echo yes )"

# 44. linkinfo reports whether the applied mesh is running, so the status page
#     can tell "turned off" from "unreadable".
reset_cfg
echo "linkinfo_stopped=$(link_info 2>/dev/null | sed -n 's/^state active=//p')"
uci set meshassistant.config.running=1
echo "linkinfo_running=$(link_info 2>/dev/null | sed -n 's/^state active=//p')"

# 45. client_info leaves out a station that has been silent longer than the
#     inactivity limit.  After a client roams to another node the old AP keeps
#     a station entry with the stale signal until hostapd drops it, and listing
#     it made the device look connected to two nodes at once.
reset_cfg
MESHASSISTANT_SYS_CLASS_NET="$TEST_INITD_STATE/sys"
mkdir -p "$MESHASSISTANT_SYS_CLASS_NET/br-lan/brif/phy0.0-ap0" \
    "$MESHASSISTANT_SYS_CLASS_NET/phy0.0-ap0"
printf '0x1\n' > "$MESHASSISTANT_SYS_CLASS_NET/br-lan/brif/phy0.0-ap0/port_no"
: > "$MESHASSISTANT_SYS_CLASS_NET/phy0.0-ap0/phy80211"
hardif_is_wireless() { [ -e "$MESHASSISTANT_SYS_CLASS_NET/$1/phy80211" ]; }
iw() {
    [ "$1" = "dev" ] && [ "$2" = "phy0.0-ap0" ] || return 0
    cat <<'DUMP'
Station aa:aa:aa:aa:aa:01 (on phy0.0-ap0)
	authorized:	yes
	inactive time:	1500 ms
	signal:  	-51 dBm
Station aa:aa:aa:aa:aa:02 (on phy0.0-ap0)
	authorized:	yes
	inactive time:	400000 ms
	signal:  	-76 dBm
DUMP
}
brctl() { :; }
clients_out=$(client_info)
echo "clients_active=$(printf '%s\n' "$clients_out" | awk '$2 == "aa:aa:aa:aa:aa:01" { print $6 }')"
echo "clients_stale=$(printf '%s\n' "$clients_out" | awk '$2 == "aa:aa:aa:aa:aa:02" { print $6 }')"

# 46. The server advertises an explicit DNS server as DHCP option 6 and puts
#     the original option back when the mesh is disabled.  Other DHCP options
#     must survive.
reset_cfg
uci set meshassistant.config.role=server
uci set meshassistant.config.dhcp_dns='1.1.1.1 8.8.8.8'
uci add_list dhcp.lan.dhcp_option='6,9.9.9.9'
uci add_list dhcp.lan.dhcp_option='3,192.168.10.1'
create_batman_network >/dev/null
echo "dhcpopt_value=$(get_or_unset dhcp.lan.dhcp_option)"
echo "dhcpopt_saved=$(get_or_unset meshassistant.config.dhcp_dns_saved)"
echo "dhcpopt_backup=$(get_or_unset meshassistant.config.dhcp_option6_backup)"
disable_meshassistant >/dev/null
echo "dhcpopt_restored=$(get_or_unset dhcp.lan.dhcp_option)"
echo "dhcpopt_saved_flag=$(get_or_unset meshassistant.config.dhcp_dns_saved)"
echo "dhcpopt_backup_flag=$(get_or_unset meshassistant.config.dhcp_option6_backup)"

# 47. An invalid address is rejected before anything is changed, so a working
#     option 6 keeps advertising.
reset_cfg
uci set meshassistant.config.role=server
uci set meshassistant.config.dhcp_dns='1.1.1'
uci add_list dhcp.lan.dhcp_option='6,9.9.9.9'
create_batman_network >/dev/null
echo "dhcpopt_invalid=$(get_or_unset dhcp.lan.dhcp_option)"
echo "dhcpopt_invalid_saved=$(get_or_unset meshassistant.config.dhcp_dns_saved)"

# 48. Clearing the field removes the advertised server again.
reset_cfg
uci set meshassistant.config.role=server
uci set meshassistant.config.dhcp_dns=1.1.1.1
create_batman_network >/dev/null
uci del meshassistant.config.dhcp_dns
create_batman_network >/dev/null
echo "dhcpopt_cleared=$(get_or_unset dhcp.lan.dhcp_option)"

# 49. A DHCP node schedules the LAN lease watchdog after the apply; a static
#     node and a server do not.
lan_dhcp_lease_watchdog() { : > "$TEST_INITD_STATE/watchdog"; }
reset_cfg
uci set meshassistant.config.role=off
uci set meshassistant.config.ipmode=dhcp
create_batman_network >/dev/null
echo "dhcp_watchdog=$( [ -e "$TEST_INITD_STATE/watchdog" ] && echo yes || echo no )"
reset_cfg
uci set meshassistant.config.role=off
uci set meshassistant.config.ipmode=static
uci set meshassistant.config.ipaddr=192.168.10.112
uci set meshassistant.config.netmask=255.255.255.0
create_batman_network >/dev/null
echo "static_watchdog=$( [ -e "$TEST_INITD_STATE/watchdog" ] && echo yes || echo no )"
reset_cfg
uci set meshassistant.config.role=server
create_batman_network >/dev/null
echo "server_watchdog=$( [ -e "$TEST_INITD_STATE/watchdog" ] && echo yes || echo no )"

# 50. The lease check warns only when the LAN interface has no lease; it logs
#     the address when one was obtained.
lease_log="$TEST_INITD_STATE/lease.log"
log_append() { printf '%s\n' "$*" >> "$lease_log"; }
ubus() {
    printf '%s\n' '{"up":true,"ipv4-address":[{"address":"192.168.10.123","mask":24}]}'
}
jsonfilter() { sed -n 's/.*"address":"\\([^"]*\\)".*/\\1/p'; }
echo "lease_present=$(lan_dhcp_lease_check >/dev/null; echo $?)"
ubus() { return 127; }
jsonfilter() { return 127; }
echo "lease_missing=$(lan_dhcp_lease_check >/dev/null; echo $?)"
echo "lease_warning=$(grep -c 'no DHCP lease' "$lease_log")"
`;
}

function writeInitScripts(dir) {
	const initDir = path.join(dir, 'init.d');
	const stateDir = path.join(dir, 'state');

	fs.mkdirSync(initDir, { recursive: true });
	fs.mkdirSync(stateDir, { recursive: true });

	const body = `#!/bin/sh
name=$(basename "$0")
state="$TEST_INITD_STATE/$name.enabled"
case "$1" in
	enabled)  [ -e "$state" ] ;;
	disabled) [ ! -e "$state" ] ;;
	enable)   : > "$state" ;;
	disable)  rm -f "$state" ;;
	start|stop|restart) : ;;
	status)
		if [ -e "$TEST_INITD_STATE/$name.running" ]; then
			echo running
			exit 0
		fi
		echo "not running"
		exit 5
		;;
	*) exit 1 ;;
esac
`;

	for (const name of [ 'firewall', 'dnsmasq', 'odhcpd', 'meshassistant', 'dawn' ])
		fs.writeFileSync(path.join(initDir, name), body, { mode: 0o700 });

	return { initDir, stateDir };
}

function runHarness() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshassistant-script-'));
	const file = path.join(dir, 'harness.sh');
	const { initDir, stateDir } = writeInitScripts(dir);

	fs.writeFileSync(file, buildHarness(), { mode: 0o700 });

	const res = childProcess.spawnSync('bash', [ file ], {
		encoding: 'utf8',
		timeout: 30000,
		env: Object.assign({}, process.env, {
			TEST_INITD: initDir,
			TEST_INITD_STATE: stateDir
		})
	});

	fs.rmSync(dir, { recursive: true, force: true });

	if (res.error)
		throw res.error;

	if (res.status !== 0)
		throw new Error('harness failed (' + res.status + '):\n' + res.stderr);

	const values = {};

	for (const line of res.stdout.split(/\r?\n/)) {
		const m = /^([a-z0-9_]+)=(.*)$/.exec(line);
		if (m)
			values[m[1]] = m[2];
	}

	return { values, stdout: res.stdout, stderr: res.stderr };
}

function run() {
	const { values, stdout } = runHarness();

	lib.eq(values.server1_master, 'bat0', 'server first run keeps mesh_batman.master');
	lib.eq(values.server1_proto, 'batadv_hardif', 'server first run sets batadv_hardif');
	lib.eq(values.server1_device, 'UNSET', 'server first run leaves device unset');
	lib.eq(values.server1_gw, 'server', 'server first run sets bat0 gw_mode');
	lib.ok((values.server1_ports || '').split(/\s+/).includes('bat0'),
		'server adds bat0 to the LAN bridge', values.server1_ports);
	lib.eq(values.server1_lan_zone, 'lan bat0', 'server adds bat0 to the LAN zone');
	lib.eq(values.server1_wan_zone, 'wwan', 'server keeps the wwan uplink in the WAN zone');
	lib.eq(values.server1_forwarding_added, 'UNSET',
		'server does not add a forwarding rule when one already exists');
	lib.eq(values.server1_forwarding_count, '1', 'server does not duplicate forwarding rules');
	lib.eq(values.server2_master, 'bat0', 'server reapply keeps mesh_batman.master');
	lib.eq(values.server2_proto, 'batadv_hardif', 'server reapply keeps batadv_hardif');
	lib.eq(values.server2_device, 'UNSET', 'server reapply leaves device unset');
	lib.eq(values.server2_ports.split(/\s+/).filter(x => x === 'bat0').length, 1,
		'server reapply does not duplicate the bat0 bridge port');
	lib.eq(values.server2_forwarding_count, '1', 'server reapply keeps a single forwarding rule');

	lib.eq(values.unset_role_gw, 'server', 'an empty role is treated as server');
	lib.eq(values.unset_role_lan_zone, 'lan bat0',
		'an empty role still adds bat0 to the LAN zone');

	lib.eq(values.node_repair_master, 'bat0', 'node run repairs a stale hardif without master');
	lib.eq(values.node_repair_proto, 'batadv_hardif', 'node run repairs the hardif protocol');
	lib.eq(values.node_fresh_master, 'bat0', 'fresh node run sets mesh_batman.master');
	lib.eq(values.node_fresh_gw, 'off', 'fresh node run sets bat0 gw_mode off');
	lib.ok(values.node_fresh_ports.split(/\s+/).includes('bat0'),
		'node adds bat0 to the LAN bridge', values.node_fresh_ports);
	lib.ok(!values.node_fresh_ports.split(/\s+/).includes('wan'),
		'node does not add the wan port to br-lan', values.node_fresh_ports);
	lib.eq(values.node_fresh_zone0, 'zone', 'node keeps firewall zone 0');
	lib.eq(values.node_fresh_zone1, 'zone', 'node keeps firewall zone 1');
	lib.eq(values.node_fresh_wan_zone, 'wwan', 'node keeps the WAN zone uplink');
	lib.eq(values.node_fresh_disabled_fw, '1', 'node records the disabled firewall');
	lib.eq(values.node_fresh_disabled_dns, '1', 'node records the disabled dnsmasq');
	lib.eq(values.node_fresh_disabled_odhcpd, '1', 'node records the disabled odhcpd');
	lib.eq(values.node_fresh_fw_state, 'disabled', 'node actually disables the firewall');

	lib.eq(values.mesh_section, 'wifi-iface', 'mesh section is created');
	lib.eq(values.mesh_device, 'radio0', 'mesh section uses the passed radio');
	lib.eq(values.mesh_network, 'mesh_batman', 'mesh section joins mesh_batman');
	lib.eq(values.mesh_mode, 'mesh', 'mesh section uses 802.11s mode');
	lib.eq(values.mesh_id, 'meshassistant_AC-mesh', 'mesh section appends -mesh');
	lib.eq(values.mesh_ifname, 'mesh_radio0', 'mesh section uses a stable ifname');
	lib.eq(values.mesh_key, 'my home network',
		'a mesh passphrase with spaces is stored intact');
	lib.eq(values.mesh_key_encryption, 'sae',
		'an encrypted mesh AP uses SAE');
	lib.eq(values.mesh_key_failure_status, '1',
		'a failed mesh key write fails the radio setup');
	lib.eq(values.ap_section, 'wifi-iface', 'regular AP section is created');
	lib.eq(values.ap_device, 'radio1', 'regular AP uses wifi_radio');
	lib.eq(values.ap_ssid, 'meshassistant_AC', 'regular AP uses wifi_id');

	lib.eq(values.multi_ap0, 'wifi-iface', 'first selected AP radio is created');
	lib.eq(values.multi_ap0_device, 'radio0', 'first AP section uses its own radio');
	lib.eq(values.multi_ap0_ssid, 'meshassistant_AC', 'first AP uses the shared SSID');
	lib.eq(values.multi_ap1, 'wifi-iface', 'second selected AP radio is created');
	lib.eq(values.multi_ap1_device, 'radio1', 'second AP section uses its own radio');
	lib.eq(values.multi_ap1_ssid, values.multi_ap0_ssid,
		'both AP radios use the same SSID');
	lib.eq(values.multi_managed, 'radio0 radio1',
		'selected AP radios are recorded as managed');

	lib.eq(values.sep_ap0_ssid, 'ap_2g', 'separate mode uses the first radio SSID');
	lib.eq(values.sep_ap1_ssid, 'ap_5g', 'separate mode uses the second radio SSID');
	lib.eq(values.fallback_ap0_ssid, 'meshassistant_AC',
		'an unset per-radio SSID falls back to the shared SSID');
	lib.eq(values.fallback_ap1_ssid, 'ap_5g',
		'a configured per-radio SSID is still used');
	lib.eq(values.band_mesh_section, 'wifi-iface', 'a band-split radio gets a mesh section');
	lib.eq(values.band_mesh_ifname, 'mesh_2',
		'a band-split radio derives the ifname from the band');
	lib.ok(values.band_mesh_ifname.length <= 15,
		'the mesh ifname fits the kernel netdev limit', values.band_mesh_ifname);
	lib.eq(values.same_ap0_ssid, 'meshassistant_AC',
		'same mode ignores per-radio SSIDs');
	lib.eq(values.same_ap1_ssid, 'meshassistant_AC',
		'same mode keeps the shared SSID on every radio');
	lib.eq(values.sep_mlo_ssid, 'meshassistant_AC',
		'MLO ignores per-radio SSIDs and uses the shared SSID');

	lib.eq(values.stale_ap_removed, 'UNSET',
		'a deselected managed AP section is removed');
	lib.eq(values.kept_ap, 'wifi-iface', 'the selected AP section is kept');
	lib.eq(values.user_ap, 'wifi-iface',
		'a user-created AP section is not removed');
	lib.eq(values.stale_managed, 'radio1', 'the managed list follows the selection');

	lib.eq(values.ap6g_section, 'wifi-iface', '6 GHz AP section is created');
	lib.eq(values.ap6g_device, 'radio2', '6 GHz AP section uses its own radio');
	lib.eq(values.ap6g_ssid, 'meshassistant_AC', '6 GHz AP uses the shared SSID');
	lib.eq(values.ap6g_encryption, 'sae-mixed',
		'6 GHz AP uses the same mixed encryption setting');
	lib.eq(values.ap6g_key, 'secret123', '6 GHz AP uses the network key');
	lib.eq(values.ap5g_encryption, 'sae-mixed',
		'5 GHz AP keeps the mixed encryption setting');
	lib.eq(values.ap6g_managed, 'radio1 radio2',
		'5 GHz and 6 GHz AP radios are recorded as managed');

	lib.eq(values.mlo_section, 'wifi-iface', 'MLO creates one MLD section');
	lib.eq(values.mlo_device, 'radio0 radio1', 'the MLD section lists both radios');
	lib.eq(values.mlo_flag, '1', 'the MLD section enables MLO');
	lib.eq(values.mlo_mode, 'ap', 'the MLD section is an access point');
	lib.eq(values.mlo_ssid, 'meshassistant_AC', 'the MLD uses the shared SSID');
	lib.eq(values.mlo_network, 'lan', 'the MLD joins the LAN bridge');
	lib.eq(values.mlo_disabled, '0', 'the MLD section is enabled');
	lib.eq(values.mlo_encryption, 'sae-mixed', 'the MLD keeps the mixed encryption');
	lib.eq(values.mlo_key, 'secret123', 'the MLD uses the network key');
	lib.eq(values.mlo_ap0, 'UNSET', 'the first per-radio AP is removed for MLO');
	lib.eq(values.mlo_ap1, 'UNSET', 'the second per-radio AP is removed for MLO');
	lib.eq(values.mlo_htmode0, 'EHT40', 'HE40 is switched to EHT40 for MLO');
	lib.eq(values.mlo_htmode1, 'EHT160', 'EHT htmode is kept for MLO');
	lib.eq(values.mlo_managed, 'radio0 radio1', 'MLO still records the managed radios');

	lib.eq(values.one_radio_ap, 'wifi-iface',
		'MLO with one radio falls back to a per-radio AP');
	lib.eq(values.one_radio_mlo, 'UNSET',
		'MLO with one radio removes a stale MLD section');
	lib.eq(values.one_radio_htmode, 'HE80',
		'MLO with one radio does not change the htmode');

	lib.eq(values.off_mlo, 'UNSET', 'disabling MLO deletes the MLD section');
	lib.eq(values.off_ap0, 'wifi-iface', 'disabling MLO restores the first AP');
	lib.eq(values.off_ap1, 'wifi-iface', 'disabling MLO restores the second AP');

	lib.eq(values.mlo_htmode_ht, 'EHT20', 'HT20 is switched to EHT20 for MLO');
	lib.eq(values.mlo_htmode_missing, 'EHT20',
		'a missing htmode defaults to EHT20 for MLO');

	lib.eq(values.roam_k, '1', 'roaming on writes 802.11k');
	lib.eq(values.roam_v, '1', 'roaming on writes 802.11v when wpad supports it');
	lib.eq(values.roam_nov_k, '1', '802.11k is still written without 802.11v support');
	lib.eq(values.roam_nov_v, 'UNSET',
		'802.11v is not written when wpad lacks support');
	lib.eq(values.roam_off_k, 'UNSET', 'roaming off removes a stale 802.11k');
	lib.eq(values.roam_off_v, 'UNSET', 'roaming off removes a stale 802.11v');

	lib.eq(values.ft_default, '1', '802.11r is on by default');
	lib.eq(values.ft_default_md, '4f57',
		'802.11r uses the configured mobility domain');
	lib.eq(values.ft_default_ds, '0', '802.11r stays in over-the-air mode');
	lib.eq(values.ft_default_psk, '0',
		'802.11r leaves the PSK handling to hostapd');
	lib.eq(values.ft_off_r, 'UNSET', 'turning 802.11r off removes ieee80211r');
	lib.eq(values.ft_off_k, '1',
		'802.11r off does not disable 802.11k');
	lib.eq(values.ft_off_md, 'UNSET',
		'turning 802.11r off removes a stale mobility domain');
	lib.eq(values.ft_off_ds, 'UNSET',
		'turning 802.11r off removes a stale ft_over_ds');
	lib.eq(values.ft_off_psk, 'UNSET',
		'turning 802.11r off removes a stale ft_psk_generate_local');

	lib.ok(/^[0-9a-f]{4}$/.test(values.mobility_derived || ''),
		'the derived mobility domain is four hex digits', values.mobility_derived);
	lib.eq(values.mobility_again, values.mobility_derived,
		'the same Mesh SSID always derives the same mobility domain');
	lib.ok(values.mobility_other !== values.mobility_derived,
		'a different Mesh SSID derives a different mobility domain');
	lib.eq(values.mobility_ap, values.mobility_derived,
		'the AP section uses the derived mobility domain');

	lib.eq(values.dawn_global, 'metric', 'DAWN gets the named global metric section');
	lib.eq(values.dawn_kicking, '3', 'DAWN kicks clients by default when roaming is on');
	lib.eq(values.dawn_threshold, '20',
		'DAWN ignores a single stray sample below the threshold');
	lib.eq(values.dawn_minkick, '3', 'DAWN needs three samples before kicking');
	lib.eq(values.dawn_nr, '1', 'DAWN publishes neighbor reports');
	lib.eq(values.dawn_duration, '150',
		'DAWN gets a non-zero 802.11k/BTM duration');
	lib.eq(values.dawn_good, '-65', 'the Good RSSI value reaches the 2.4 GHz band');
	lib.eq(values.dawn_good_a, '-65', 'the Good RSSI value reaches the 5 GHz band');
	lib.eq(values.dawn_bad, '-85', 'the Bad RSSI value reaches the 2.4 GHz band');
	lib.eq(values.dawn_center, '-85',
		'the absolute RSSI check uses the Bad RSSI value');
	lib.eq(values.dawn_center_a, '-85',
		'the absolute RSSI check is the same on 5 GHz');
	lib.eq(values.dawn_shared,
		crypto.createHash('md5').update('meshassistant:secret123').digest('hex'),
		'the DAWN shared key is derived from the network key');
	lib.eq(values.dawn_net_named, 'UNSET',
		'the shared key goes into the existing network section, not a new one');
	lib.eq(values.dawn_managed, 'yes', 'the DAWN config is marked as managed');
	lib.eq(values.dawn_enabled, 'enabled', 'DAWN is enabled with roaming on');
	lib.eq(values.dawn_default_good, '-60',
		'an empty Good RSSI falls back to -60 dBm');
	lib.eq(values.dawn_default_bad, '-88',
		'an empty Bad RSSI falls back to -88 dBm');
	lib.eq(values.band_ax_section, 'metric',
		'the 6 GHz band section exists for DAWN');
	lib.eq(values.band_g_good, '-60',
		'the 2.4 GHz band keeps the shared Good RSSI');
	lib.eq(values.band_g_bad, '-88',
		'the 2.4 GHz band keeps the shared Bad RSSI');
	lib.eq(values.band_a_good, '-70',
		'the 5 GHz override replaces the shared Good RSSI');
	lib.eq(values.band_a_bad, '-80',
		'the 5 GHz override replaces the shared Bad RSSI');
	lib.eq(values.band_a_center, '-80',
		'the 5 GHz absolute check follows the band override');
	lib.eq(values.band_ax_good, '-55',
		'the 6 GHz override replaces the shared Good RSSI');
	lib.eq(values.band_ax_bad, '-88',
		'an unset 6 GHz Bad RSSI inherits the shared value');
	lib.eq(values.band_ax_center, '-88',
		'the 6 GHz absolute check follows the inherited value');
	lib.eq(values.band_a_inherit, '-60',
		'removing the 5 GHz override restores the shared Good RSSI');
	lib.eq(values.band_ax_inherit, '-88',
		'removing band overrides keeps the shared thresholds');
	lib.eq(values.dawn_restored, 'original-dawn-config',
		'turning roaming off restores the pre-existing DAWN config');
	lib.eq(values.dawn_released, 'no', 'turning roaming off drops the managed marker');
	lib.eq(values.dawn_backup_gone, 'no', 'turning roaming off removes the backup');
	lib.eq(values.dawn_off_state, 'disabled', 'turning roaming off disables DAWN');

	lib.eq(values.dawn_nov_managed, 'no',
		'without 802.11v the managed marker is dropped');
	lib.eq(values.dawn_nov_state, 'disabled',
		'without 802.11v DAWN is left stopped');
	lib.eq(values.dawn_nov_restored, 'backup-dawn-config',
		'without 802.11v the saved DAWN config is restored');
	lib.eq(values.dawn_nov_warning, '1',
		'the missing 802.11v support is reported in the log');

	lib.eq(values.lock_first_rc, '0', 'an idle device takes the run lock');
	lib.eq(values.lock_second_rc, '1',
		'a second operation is refused while the lock is held');
	lib.ok((values.lock_second_msg || '').includes('already running'),
		'the lock refusal says another operation is running', values.lock_second_msg);

	lib.eq(values.caps_off_supported, 'kvr=0|wnm=1|dawn=1|dawn_running=0|',
		'the status hint reports a supported device with roaming off and DAWN stopped');
	lib.eq(values.caps_on_unsupported, 'kvr=1|wnm=0|dawn=1|dawn_running=0|',
		'the status hint reports missing 802.11v while roaming is on');
	lib.eq(values.caps_no_dawn, 'kvr=0|wnm=1|dawn=0|dawn_running=0|',
		'the status hint reports a missing DAWN install');
	lib.eq(values.caps_dawn_stopped, 'kvr=0|wnm=1|dawn=1|dawn_running=0|',
		'an installed but stopped DAWN is reported as not running');
	lib.eq(values.caps_dawn_running, 'kvr=0|wnm=1|dawn=1|dawn_running=1|',
		'a running DAWN is reported as running');
	lib.eq(values.caps_dawn_restarts,
		'kvr=0|wnm=1|dawn=1|dawn_running=1|dawn_restarts=7|',
		'a running DAWN reports its procd respawn count');
	lib.eq(values.caps_dawn_restarts_unknown,
		'kvr=0|wnm=1|dawn=1|dawn_running=1|',
		'the respawn count is omitted when procd cannot report it');
	lib.eq(values.caps_rc, '0',
		'the probe succeeds even when the respawn count is unavailable');

	lib.eq(values.roaming_report,
		'bss phy0.0-ap0 2462 40 26 3|bss phy0.1-ap0 5180 - - -|',
		'the roaming report lists transition counters per BSS');
	lib.eq(values.roaming_empty, '0',
		'a missing ubus yields an empty roaming report');

	lib.ok(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] hello world$/.test(values.log_line || ''),
		'run log notes are timestamped', values.log_line);
	lib.ok((values.commit_log || '').includes('Committing UCI changes (wireless):'),
		'the run log names the committed config', values.commit_log);
	lib.ok((values.commit_log || '').includes("wireless.wifi_ap_radio0.key='***'"),
		'committed keys are masked in the run log', values.commit_log);
	lib.ok(!(values.commit_log || '').includes('secret123'),
		'the network key never reaches the run log', values.commit_log);
	lib.ok((values.commit_log || '').includes("dawn.cfg0a1b2c.shared_key='***'"),
		'the DAWN shared key is masked in the run log', values.commit_log);
	lib.ok(!(values.commit_log || '').includes('186b38882493c85660fdd39cd3ec27f0'),
		'the DAWN shared key value never reaches the run log', values.commit_log);
	lib.ok((values.commit_log || '').includes("network.lan.ipaddr='192.168.10.1'"),
		'other committed options are shown in the run log', values.commit_log);

	lib.eq(values.log_append_line, 'Created backup: /etc/meshassistant/backup/test.tar',
		'the backup audit line is appended to the run log file');
	lib.eq(values.log_append_timestamped, '1',
		'the appended backup line is timestamped');
	lib.ok(Number(values.log_trim_bytes) < 400,
		'the run log is trimmed back under its size limit', values.log_trim_bytes);
	lib.eq(values.log_trim_newest, 'line 40',
		'the log keeps the newest entries after trimming');

	lib.eq(values.clear_matching, 'UNSET', 'clear_by_mesh_id removes the matching -mesh section');
	lib.eq(values.clear_other, 'wifi-iface', 'clear_by_mesh_id keeps other mesh sections');

	lib.eq(values.legacy_regular_ap, 'wifi-iface',
		'clear_by_mesh_id keeps a regular AP with the same SSID');
	lib.eq(values.legacy_mesh_removed, 'UNSET',
		'clear_by_mesh_id removes a legacy mesh wifinet bound to mesh_batman');
	lib.eq(values.legacy_other_mesh, 'wifi-iface',
		'clear_by_mesh_id keeps a legacy mesh wifinet with another SSID');

	lib.eq(values.multi_exit, '1', 'multi-value apRadio is rejected');
	lib.ok((values.multi_output || '').includes('exactly one Mesh radio'),
		'multi-value apRadio reports a clear error', values.multi_output);

	lib.eq(values.mesh_empty_exit, '1', 'an empty Mesh SSID aborts the apply');
	lib.ok((values.mesh_empty_output || '').includes('Mesh SSID is empty'),
		'an empty Mesh SSID reports a clear error', values.mesh_empty_output);
	lib.eq(values.mesh_empty_iface, 'UNSET',
		'an empty Mesh SSID does not create network.mesh_batman');
	lib.eq(values.mesh_empty_wireless, 'UNSET',
		'an empty Mesh SSID does not create a mesh wireless section');
	lib.eq(values.mesh_empty_running, 'UNSET',
		'an empty Mesh SSID does not record a successful run');
	lib.eq(values.mesh_setup_rc, '1',
		'setup_mesh_radio reports an empty Mesh SSID');
	lib.eq(values.process_radios_rc, '1',
		'process_radios propagates the mesh setup failure');
	lib.eq(values.apply_mesh_rc, '1',
		'apply_mesh_config refuses an empty Mesh SSID');

	lib.eq(values.node_static_proto, 'static', 'node static mode sets proto static');
	lib.eq(values.node_static_ip, '192.168.10.2', 'node static mode sets the address');
	lib.eq(values.node_static_gw, '192.168.10.1', 'node static mode sets the gateway');
	lib.eq(values.node_static_dns, '192.168.10.1', 'node static mode sets DNS');
	lib.eq(values.node_static_peerdns, 'UNSET',
		'static mode does not keep a DHCP peer-DNS setting');
	lib.eq(values.node_static_hostname, 'node2', 'node sets the hostname');
	lib.eq(values.node_saved_lan, '1', 'node records that the LAN state was saved');
	lib.eq(values.node_saved_hostname, '1', 'node records that the hostname was saved');
	lib.eq(values.restore_proto, 'static', 'disable restores the LAN protocol');
	lib.eq(values.restore_ip, '192.168.10.1', 'disable restores the LAN address');
	lib.eq(values.restore_netmask, '255.255.255.0', 'disable restores the netmask');
	lib.eq(values.restore_gw, 'UNSET', 'disable restores an unset gateway');
	lib.eq(values.restore_dns, 'UNSET', 'disable restores an unset DNS');
	lib.eq(values.restore_peerdns, '0',
		'disable restores the original peer-DNS setting');
	lib.eq(values.restore_hostname, 'OpenWrt', 'disable restores the hostname');
	lib.ok(!values.restore_ports.split(/\s+/).includes('bat0'),
		'disable removes bat0 from the LAN bridge', values.restore_ports);
	lib.eq(values.restore_bat0, 'UNSET', 'disable removes bat0');
	lib.eq(values.restore_hardif, 'UNSET', 'disable removes mesh_batman');
	lib.eq(values.restore_zone0, 'zone', 'disable keeps the firewall zones');
	lib.eq(values.restore_disabled_fw, 'UNSET', 'disable clears the disabled-service record');
	lib.eq(values.restore_fw_state, 'enabled', 'disable re-enables the firewall');
	lib.eq(values.restore_saved_lan, 'UNSET', 'disable clears the saved LAN state');

	lib.eq(values.node_dhcp_proto, 'dhcp', 'node DHCP mode sets proto dhcp');
	lib.eq(values.node_dhcp_ip, 'UNSET', 'node DHCP mode removes the static address');
	lib.eq(values.node_dhcp_netmask, 'UNSET', 'node DHCP mode removes the netmask');
	lib.eq(values.node_dhcp_dns, '192.168.10.53',
		'node DHCP mode writes the configured DNS server');
	lib.eq(values.node_dhcp_peerdns, '0',
		'a configured DNS server replaces the advertised ones');
	lib.eq(values.node_dhcp_restore_dns, 'UNSET',
		'disable removes the DHCP DNS override');
	lib.eq(values.node_dhcp_restore_peerdns, 'UNSET',
		'disable removes the peerdns override');
	lib.eq(values.node_dhcp_nodns_dns, 'UNSET',
		'without a DNS server the LAN keeps no override');
	lib.eq(values.node_dhcp_nodns_peerdns, 'UNSET',
		'without a DNS server the advertised servers stay in use');

	lib.eq(values.static_clear_gateway, 'UNSET',
		'clearing the gateway removes the previous default route');
	lib.eq(values.static_clear_dns, 'UNSET',
		'clearing the DNS field removes the previous DNS servers');

	lib.eq(values.dumbap_fw_record, 'UNSET',
		'a service the administrator already disabled is not recorded');
	lib.eq(values.dumbap_dns_record, '1',
		'Dumb AP records the dnsmasq it disabled');
	lib.eq(values.dumbap_odhcpd_record, '1',
		'Dumb AP records the odhcpd it disabled');
	lib.eq(values.dumbap_fw_state, 'disabled',
		'Dumb AP leaves an already disabled firewall off');
	lib.eq(values.dumbap_dns_state, 'disabled',
		'Dumb AP stops dnsmasq');
	lib.eq(values.undumb_fw_state, 'disabled',
		'leaving Dumb AP does not enable a service the administrator disabled');
	lib.eq(values.undumb_dns_state, 'enabled',
		'leaving Dumb AP restores the dnsmasq it disabled');
	lib.eq(values.undumb_dns_record, 'UNSET',
		'leaving Dumb AP clears the service record');
	lib.eq(values.undumb_apmode, 'UNSET',
		'leaving Dumb AP clears the mode flag');

	lib.eq(values.dumbap_apmode, '1', 'enabling Dumb AP sets the mode flag');
	lib.eq(values.dumbap_backup, 'original network',
		're-applying Dumb AP keeps the original configuration snapshot');

	lib.eq(values.dumbap_static_gateway, 'UNSET',
		'Dumb AP static mode removes a cleared gateway');
	lib.eq(values.dumbap_static_dns, 'UNSET',
		'Dumb AP static mode removes cleared DNS servers');
	lib.eq(values.node_dhcp_restore_proto, 'static', 'disable restores proto after DHCP mode');
	lib.eq(values.node_dhcp_restore_ip, '192.168.10.1',
		'disable restores the address after DHCP mode');
	lib.eq(values.node_dhcp_restore_hostname, 'OpenWrt',
		'disable restores the hostname after DHCP mode');

	lib.eq(values.nodhcp_ignore, '1', 'server_dhcp=0 sets dhcp.lan.ignore');
	lib.eq(values.nodhcp_ra, 'disabled', 'server_dhcp=0 disables IPv6 RA');
	lib.eq(values.nodhcp_dhcpv6, 'disabled', 'server_dhcp=0 disables DHCPv6');
	lib.eq(values.nodhcp_disabled_odhcpd, '1', 'server_dhcp=0 records the disabled odhcpd');
	lib.eq(values.nodhcp_dns_state, 'enabled', 'server_dhcp=0 keeps dnsmasq for DNS');
	lib.eq(values.nodhcp_odhcpd_state, 'disabled', 'server_dhcp=0 stops odhcpd');
	lib.eq(values.dhcp_restored_ignore, 'UNSET', 'server_dhcp=1 restores dhcp.lan.ignore');
	lib.eq(values.dhcp_restored_ra, 'UNSET', 'server_dhcp=1 restores the RA setting');
	lib.eq(values.dhcp_restored_disabled_odhcpd, 'UNSET',
		'server_dhcp=1 clears the odhcpd record');
	lib.eq(values.dhcp_restored_odhcpd_state, 'enabled', 'server_dhcp=1 re-enables odhcpd');

	lib.eq(values.dhcpopt_value, '3,192.168.10.1 6,1.1.1.1,8.8.8.8',
		'the server advertises the configured DNS server as option 6 and keeps other options');
	lib.eq(values.dhcpopt_saved, '1',
		'advertising option 6 records that the original options were saved');
	lib.eq(values.dhcpopt_backup, '6,9.9.9.9',
		'the original option 6 is saved before it is replaced');
	lib.eq(values.dhcpopt_restored, '3,192.168.10.1 6,9.9.9.9',
		'disable puts the original option 6 back and keeps other options');
	lib.eq(values.dhcpopt_saved_flag, 'UNSET',
		'disable clears the option 6 save flag');
	lib.eq(values.dhcpopt_backup_flag, 'UNSET',
		'disable clears the option 6 backup');

	lib.eq(values.dhcpopt_invalid, '6,9.9.9.9',
		'an invalid DHCP DNS server leaves the current option 6 alone');
	lib.eq(values.dhcpopt_invalid_saved, 'UNSET',
		'an invalid DHCP DNS server is rejected before the options are saved');

	lib.eq(values.dhcpopt_cleared, '',
		'clearing the DHCP DNS server removes the advertised option 6');

	lib.eq(values.dhcp_watchdog, 'yes',
		'a DHCP node schedules the LAN lease watchdog');
	lib.eq(values.static_watchdog, 'no',
		'a static node does not schedule the LAN lease watchdog');
	lib.eq(values.server_watchdog, 'no',
		'the server does not schedule the LAN lease watchdog');
	lib.eq(values.lease_present, '0', 'a LAN lease passes the check');
	lib.eq(values.lease_missing, '1', 'a missing LAN lease fails the check');
	lib.eq(values.lease_warning, '1',
		'a missing LAN lease is recorded in the run log');

	lib.eq(values.empty_wan_zone, 'wan', 'empty WAN zone gets the wan network');
	lib.eq(values.empty_wan_masq, '1', 'empty WAN zone gets NAT');
	lib.eq(values.empty_forwarding, 'lan', 'a lan to wan forwarding rule is created');
	lib.eq(values.empty_forwarding_added, '1', 'the created forwarding rule is recorded');
	lib.eq(values.empty_forwarding_removed, 'UNSET', 'disable removes the created forwarding rule');
	lib.eq(values.empty_forwarding_flag, 'UNSET', 'disable clears the forwarding record');

	lib.eq(values.wired_proto, 'batadv_hardif', 'wired backhaul uses batadv_hardif');
	lib.eq(values.wired_master, 'bat0', 'wired backhaul joins bat0');
	lib.eq(values.wired_device, 'lan3', 'wired backhaul uses the selected port');
	lib.eq(values.wired_mtu, '1500', 'wired backhaul keeps a standard MTU');
	lib.eq(values.wired_override, '10000mbit',
		'wired backhaul overrides throughput with the port speed');
	lib.eq(values.wired_override_unknown, 'UNSET',
		'no wired throughput override when the port speed is unknown');
	lib.eq(values.wired_override_down, 'UNSET',
		'no wired throughput override when the port is down');
	lib.eq(values.wired_override_kept, '2500mbit',
		'a wired override survives a reapply while the port is down');
	lib.ok(!values.wired_ports.split(/\s+/).includes('lan3'),
		'wired port is removed from the LAN bridge', values.wired_ports);
	lib.ok(values.wired_ports.split(/\s+/).includes('bat0'),
		'wired server keeps bat0 in the LAN bridge', values.wired_ports);
	lib.eq(values.wired_removed, '1', 'wired bridge removal is recorded');
	lib.eq(values.wired_restore, 'lan3', 'wired restore port is recorded');
	lib.ok(!values.wired_reapply_ports.split(/\s+/).includes('lan3'),
		'wired reapply keeps the port out of the LAN bridge', values.wired_reapply_ports);
	lib.eq(values.wired_reapply_device, 'lan3', 'wired reapply keeps the port');

	lib.eq(values.wired_node_proto, 'batadv_hardif', 'node wired backhaul uses batadv_hardif');
	lib.eq(values.wired_node_master, 'bat0', 'node wired backhaul joins bat0');
	lib.eq(values.wired_node_device, 'lan2', 'node wired backhaul uses the selected port');
	lib.ok(!values.wired_node_ports.split(/\s+/).includes('lan2'),
		'node removes the wired port from the LAN bridge', values.wired_node_ports);
	lib.eq(values.wired_node_gw, 'off', 'wired node keeps gateway mode off');

	lib.eq(values.wired_change_device, 'lan3', 'changing the port updates mesh_wired');
	lib.ok(!values.wired_change_ports.split(/\s+/).includes('lan3'),
		'changing the port removes the new port from the LAN bridge',
		values.wired_change_ports);
	lib.ok(values.wired_change_ports.split(/\s+/).includes('lan2'),
		'changing the port restores the old port to the LAN bridge',
		values.wired_change_ports);
	lib.eq(values.wired_change_restore, 'lan3', 'changing the port records the new restore port');

	lib.eq(values.wired_disable_iface, 'UNSET', 'disable removes mesh_wired');
	lib.ok(values.wired_disable_ports.split(/\s+/).includes('lan3'),
		'disable restores the wired port to the LAN bridge', values.wired_disable_ports);
	lib.eq(values.wired_disable_removed, 'UNSET', 'disable clears the bridge removal record');
	lib.eq(values.wired_disable_restore, 'UNSET', 'disable clears the restore port');
	lib.eq(values.wired_disable_config, 'lan3', 'disable keeps the wired port selection');

	lib.eq(values.wired_none_iface, 'UNSET', 'None leaves no wired backhaul interface');
	lib.ok(values.wired_none_ports.split(/\s+/).includes('lan3'),
		'None leaves the LAN bridge ports untouched', values.wired_none_ports);

	lib.eq(values.wired_busy_iface, 'UNSET', 'a port used by WAN is refused');
	lib.eq(values.wired_busy_ports, 'lan2 lan3 bat0',
		'a refused WAN port stays in the LAN bridge');

	lib.eq(values.wired_missing_iface, 'UNSET', 'a port outside the LAN bridge is refused');
	lib.eq(values.wired_missing_ports, 'lan2 lan3 bat0',
		'a refused port leaves the LAN bridge untouched');

	lib.eq(values.wired_unsafe_iface, 'UNSET', 'an unsafe port name is refused');
	lib.eq(values.wired_unsafe_ports, 'lan2 lan3 bat0',
		'an unsafe port name leaves the LAN bridge untouched');

	lib.eq(values.wired_readopt_device, 'lan3', 'an already dedicated port is accepted');
	lib.eq(values.wired_readopt_ports, 'lan2 bat0',
		'an already dedicated port is not re-added to the LAN bridge');
	lib.eq(values.wired_readopt_removed, 'UNSET',
		'an already dedicated port does not record a new bridge removal');
	lib.eq(values.wired_readopt_after_ports, 'lan2', 'disable does not add a non-bridge port back');
	lib.eq(values.wired_readopt_after_iface, 'UNSET', 'disable removes the dedicated interface');

	lib.eq(values.link_iface, '2437', 'link info reports the radio frequency');
	lib.eq(values.link_channel, '6', 'link info reports the radio channel');
	lib.eq(values.link_width, '40', 'link info reports the channel width');
	lib.eq(values.link_legacy, '5745',
		'a driver without a width still reports the frequency');
	lib.eq(values.link_busy, '25', 'link info reports the channel utilization');
	lib.eq(values.link_peer, '-52', 'link info reports the peer signal strength');
	lib.eq(values.link_wired, '0', 'a wired hardif has no frequency or station signal');
	lib.eq(values.link_kind_wlan, 'wlan', 'link info reports a wireless hardif kind');
	lib.eq(values.link_kind_mac, 'aa:bb:cc:dd:ee:ff',
		'link info reports the hardif MAC next to its kind');
	lib.eq(values.link_kind_wired, 'wired', 'link info reports a wired hardif kind');
	lib.eq(values.link_kind_noiw, 'wlan',
		'the hardif kind is reported without iw');
	lib.eq(values.link_iface_noiw, '0',
		'no radio data is reported without iw');
	lib.eq(values.link_local_hostname, 'OpenWrt', 'link info reports the local hostname');
	lib.eq(values.link_local_fields, '5',
		'the local line carries hostname, address, load and role');
	lib.eq(values.link_local_role, 'client',
		'the local line reports the configured role');
	lib.eq(values.link_local_default_role, 'server',
		'an unset role reports as the server default');
	lib.eq(values.log_after_clear, '0', 'clearing the run log truncates the file');

	lib.eq(values.peer_v2, 'aa:bb:cc:dd:ee:ff 192.168.10.50 nodeX 0.42',
		'version 2 announcements record the load');
	lib.eq(values.peer_v1, 'aa:bb:cc:dd:ee:ff 192.168.10.51 nodeY -',
		'version 1 announcements are still accepted without a load');
	lib.eq(values.peer_v3,
		'22:33:44:55:66:77 192.168.10.52 nodeZ 0.10 aa:bb:cc:dd:ee:ff',
		'version 3 announcements record the LAN MAC');
	lib.eq(values.peer_badlanmac, '-',
		'an invalid LAN MAC is stored as an empty field');
	lib.eq(values.peer_unknown_lines, '4', 'unknown announcement versions are ignored');
	lib.eq(values.peer_v4,
		'22:33:44:55:66:77 192.168.10.57 nodeU 0.10 aa:bb:cc:dd:ee:ff inuse',
		'version 4 announcements record the hardif state');
	lib.eq(values.peer_v4_nolan,
		'22:33:44:55:66:77 192.168.10.58 nodeT 0.20 - standby',
		'a version 4 announcement without a LAN MAC keeps its state');
	lib.eq(values.peer_v4_badstate, '-',
		'an unknown hardif state is stored as an empty field');
	lib.eq(values.peer_v4_short,
		'22:33:44:55:66:77 192.168.10.59 nodeS 0.30 aa:bb:cc:dd:ee:ff -',
		'a short version 4 line is ignored');
	lib.eq(values.peer_v5,
		'22:33:44:55:66:77 192.168.10.63 nodeQ 0.10 aa:bb:cc:dd:ee:ff inuse wired',
		'version 5 announcements record the medium of the hardif');
	lib.eq(values.peer_v5_nolan,
		'22:33:44:55:66:77 192.168.10.64 nodeP 0.20 - standby wlan',
		'a version 5 announcement without a LAN MAC keeps its state and medium');
	lib.eq(values.peer_v5_badkind, '-',
		'an unknown medium is stored as an empty field');
	lib.eq(values.peer_v5_short, '0', 'a short version 5 line is ignored');
	lib.eq(values.peer_v6,
		'22:33:44:55:66:77 192.168.10.67 nodeM 0.10 aa:bb:cc:dd:ee:ff inuse wired 100000.0',
		'version 6 announcements record the link speed of the hardif');
	lib.eq(values.peer_v6_nospeed,
		'22:33:44:55:66:77 192.168.10.68 nodeL 0.20 - standby wlan -',
		'a version 6 announcement without a measured speed keeps the placeholder');
	lib.eq(values.peer_v6_badspeed, '-',
		'a malformed link speed is stored as an empty field');
	lib.eq(values.peer_v6_short, '0', 'a short version 6 line is ignored');
	lib.eq(values.peer_v7,
		'22:33:44:55:66:77 192.168.10.71 nodeI 0.10 aa:bb:cc:dd:ee:ff inuse wired 100000.0 lan2',
		'version 7 announcements record the name of the hardif');
	lib.eq(values.peer_v7_noiface, '-',
		'a version 7 announcement without a hardif name keeps the placeholder');
	lib.eq(values.peer_v7_badiface, '-',
		'a hardif name with an invalid character is stored as an empty field');
	lib.eq(values.peer_v7_longiface, '-',
		'a hardif name longer than IFNAMSIZ is stored as an empty field');
	lib.eq(values.peer_v7_short, '0', 'a short version 7 line is ignored');
	lib.eq(values.peer_badload, '-', 'malformed load values are dropped');
	lib.eq(values.peer_dual_v2, '192.168.10.56 nodeD 0.30',
		'a datagram carrying both versions stores the version 2 line');
	lib.eq(values.peer_dual_v3, '11:22:33:44:55:66',
		'a datagram carrying both versions stores the version 3 LAN MAC');

	lib.eq(values.peer_concurrent_lines, '200',
		'concurrent announcements store every line');
	lib.eq(values.peer_concurrent_bad, '0',
		'concurrent announcements never interleave two lines');
	lib.eq(values.peer_concurrent_distinct, '8',
		'concurrent announcements keep every sender');

	lib.eq(values.peer_prune_lines, '1', 'pruning drops expired announcements');
	lib.eq(values.peer_prune_kept, '192.168.10.71',
		'pruning drops a damaged line dated in the future');

	lib.eq(values.names_local,
		'aa:bb:cc:dd:ee:01 192.168.10.101 lease-one|' +
		'aa:bb:cc:dd:ee:02 192.168.10.102 short-name|' +
		'aa:bb:cc:dd:ee:02 192.168.10.102 static-two|' +
		'aa:bb:cc:dd:ee:04 - static-four|',
		'local names come from the lease file and static reservations');
	lib.eq(values.names_record, 'aa:bb:cc:dd:ee:05 192.168.10.105 client-five',
		'a version 8 announcement stores a client name');
	lib.eq(values.names_record_sanitized, 'aa:bb:cc:dd:ee:06 - client',
		'client name fields are sanitized like peer fields');
	lib.eq(values.names_record_badmac, '0',
		'a client name with a malformed MAC is ignored');
	lib.eq(values.names_peer_untouched, '0',
		'a version 8 announcement never reaches the peer table');
	lib.eq(values.names_prune, 'aa:bb:cc:dd:ee:09',
		'pruning drops expired client names');
	lib.eq(values.names_announce,
		'meshassistant/8 aa:bb:cc:dd:ee:10 192.168.10.110 host-ten',
		'client names are broadcast as version 8 lines');
	lib.eq(values.names_announce_empty, '0',
		'an empty name table is not broadcast');

	lib.eq(values.lan_hwaddr_real, 'aa:bb:cc:dd:ee:ff',
		'lan_hwaddr accepts a six-octet MAC and lowercases it');
	lib.eq(values.announce_lines, '6',
		'an announcement sends a version 2, 3, 4, 5, 6 and 7 line');
	lib.eq(values.announce_v2_proto, 'meshassistant/2',
		'the first announcement line stays readable by older peers');
	lib.eq(values.announce_v2_mac, '22:33:44:55:66:77',
		'the version 2 line carries the mesh hardif MAC');
	lib.eq(values.announce_v2_ip, '192.168.10.2',
		'the version 2 line carries the LAN address');
	lib.eq(values.announce_v3_proto, 'meshassistant/3',
		'the second announcement line uses version 3');
	lib.eq(values.announce_v3_mac, '22:33:44:55:66:77',
		'the version 3 line carries the mesh hardif MAC');
	lib.eq(values.announce_v3_lanmac, 'aa:bb:cc:dd:ee:ff',
		'the version 3 line carries the LAN bridge MAC');
	lib.eq(values.announce_v3_ip, '192.168.10.2',
		'the version 3 line carries the LAN address');
	lib.eq(values.announce_v4_proto, 'meshassistant/4',
		'the third announcement line uses version 4');
	lib.eq(values.announce_v4_mac, '22:33:44:55:66:77',
		'the version 4 line carries the mesh hardif MAC');
	lib.eq(values.announce_v4_lanmac, 'aa:bb:cc:dd:ee:ff',
		'the version 4 line carries the LAN bridge MAC');
	lib.eq(values.announce_v4_ip, '192.168.10.2',
		'the version 4 line carries the LAN address');
	lib.eq(values.announce_v4_state, 'inuse',
		'a hardif that carries a selected originator is in use');
	lib.eq(values.announce_v5_proto, 'meshassistant/5',
		'the fourth announcement line uses version 5');
	lib.eq(values.announce_v5_mac, '22:33:44:55:66:77',
		'the version 5 line carries the mesh hardif MAC');
	lib.eq(values.announce_v5_lanmac, 'aa:bb:cc:dd:ee:ff',
		'the version 5 line carries the LAN bridge MAC');
	lib.eq(values.announce_v5_ip, '192.168.10.2',
		'the version 5 line carries the LAN address');
	lib.eq(values.announce_v5_state, 'inuse',
		'the version 5 line repeats the hardif state');
	lib.eq(values.announce_v5_kind, 'wlan',
		'the version 5 line carries the medium of the hardif');
	lib.eq(values.announce_v6_proto, 'meshassistant/6',
		'the fifth announcement line uses version 6');
	lib.eq(values.announce_v6_mac, '22:33:44:55:66:77',
		'the version 6 line carries the mesh hardif MAC');
	lib.eq(values.announce_v6_lanmac, 'aa:bb:cc:dd:ee:ff',
		'the version 6 line carries the LAN bridge MAC');
	lib.eq(values.announce_v6_ip, '192.168.10.2',
		'the version 6 line carries the LAN address');
	lib.eq(values.announce_v6_state, 'inuse',
		'the version 6 line repeats the hardif state');
	lib.eq(values.announce_v6_kind, 'wlan',
		'the version 6 line repeats the medium of the hardif');
	lib.eq(values.announce_v6_speed, '1903.4',
		'the version 6 line carries the best speed of the hardif');
	lib.eq(values.announce_v7_proto, 'meshassistant/7',
		'the sixth announcement line uses version 7');
	lib.eq(values.announce_v7_mac, '22:33:44:55:66:77',
		'the version 7 line carries the mesh hardif MAC');
	lib.eq(values.announce_v7_lanmac, 'aa:bb:cc:dd:ee:ff',
		'the version 7 line carries the LAN bridge MAC');
	lib.eq(values.announce_v7_ip, '192.168.10.2',
		'the version 7 line carries the LAN address');
	lib.eq(values.announce_v7_state, 'inuse',
		'the version 7 line repeats the hardif state');
	lib.eq(values.announce_v7_kind, 'wlan',
		'the version 7 line repeats the medium of the hardif');
	lib.eq(values.announce_v7_speed, '1903.4',
		'the version 7 line repeats the best speed of the hardif');
	lib.eq(values.announce_v7_iface, 'mesh_radio2',
		'the version 7 line carries the name of the hardif');
	lib.eq(values.announce_standby_state, 'standby',
		'a hardif without a selected originator is a standby');
	lib.eq(values.announce_unknown_state, '-',
		'an unknown state is announced without a selected originator');
	lib.eq(values.announce_no_lanmac_lines, '5',
		'an unknown LAN MAC leaves the version 2, 4, 5, 6 and 7 lines');
	lib.eq(values.announce_no_lanmac_v4_lanmac, '-',
		'the version 4 line marks a missing LAN MAC');
	lib.eq(values.announce_wired_kind, 'wired',
		'a wired hardif is announced as wired');
	lib.eq(values.announce_wired_speed, '100000.0',
		'a wired hardif announces the rate batman measures on it');
	lib.eq(values.announce_wired_iface, 'lan2',
		'a wired hardif announces its own name');
	lib.eq(values.announce_unknown_kind, '-',
		'a hardif without a known medium is announced with a placeholder');
	lib.eq(values.announce_no_neighbor_speed, '-',
		'a hardif without a direct neighbor announces no rate');
	lib.eq(values.announce_no_neighbor_iface, 'mesh_radio9',
		'a hardif without a direct neighbor still announces its name');

	lib.eq(values.spectrum_ap_country, 'TW',
		'spectrum sets the regular AP radio country');
	lib.eq(values.spectrum_ap_channel, '11',
		'spectrum sets the regular AP radio channel');
	lib.eq(values.spectrum_ap_htmode, 'EHT40',
		'spectrum combines the PHY mode and width for the AP radio');
	lib.eq(values.spectrum_ap_txpower, '25',
		'spectrum sets the regular AP radio transmit power');
	lib.eq(values.spectrum_mesh_country, 'DE',
		'spectrum sets the mesh radio country');
	lib.eq(values.spectrum_mesh_channel, 'auto',
		'spectrum accepts an automatic channel');
	lib.eq(values.spectrum_mesh_htmode, 'VHT160',
		'spectrum combines the PHY mode and width for the mesh radio');
	lib.eq(values.spectrum_mesh_txpower, '30',
		'spectrum sets the mesh radio transmit power');

	lib.eq(values.spectrum_empty_channel, '6',
		'an empty spectrum channel keeps the current channel');
	lib.eq(values.spectrum_empty_htmode, 'HT40',
		'an empty spectrum mode and width keep the current htmode');
	lib.eq(values.spectrum_empty_country, 'US',
		'an empty spectrum country keeps the current country');
	lib.eq(values.spectrum_empty_mesh_htmode, 'HE80',
		'empty spectrum settings leave the mesh radio untouched');

	lib.eq(values.spectrum_bad_pair, 'HT40',
		'an unsupported mode and width pair is rejected');
	lib.eq(values.spectrum_mode_only, 'EHT40',
		'a missing width is taken from the current htmode');
	lib.eq(values.spectrum_width_only, 'EHT80',
		'a missing mode is taken from the current htmode');
	lib.eq(values.spectrum_width_6g, 'EHT320',
		'320 MHz is accepted on 6 GHz');
	lib.eq(values.spectrum_width_5g_320, 'EHT160',
		'320 MHz is refused outside 6 GHz');

	lib.eq(values.spectrum_bad_country, 'US', 'a lowercase country is refused');
	lib.eq(values.spectrum_bad_channel, '6', 'a non-numeric channel is refused');
	lib.eq(values.spectrum_bad_txpower, '20', 'an out-of-range transmit power is refused');

	lib.eq(values.spectrum_dfs_warning, '1', 'a 5 GHz MLO DFS channel is reported');
	lib.eq(values.spectrum_dfs_channel, '100', 'the DFS channel choice is kept');

	lib.eq(values.lan_empty_mask_proto, 'static',
		'an empty netmask leaves the LAN proto untouched');
	lib.eq(values.lan_empty_mask_ip, '192.168.10.1',
		'an empty netmask leaves the LAN address untouched');
	lib.eq(values.lan_empty_mask_netmask, '255.255.255.0',
		'an empty netmask is not written to the LAN');
	lib.eq(values.lan_empty_mask_gateway, 'UNSET',
		'an empty netmask does not add a LAN gateway');
	lib.eq(values.lan_empty_mask_state, 'no',
		'an empty netmask records no address to verify');
	lib.eq(values.lan_empty_mask_warning, '1',
		'an empty netmask is reported with the /32 reason');

	lib.eq(values.lan_bad_mask_ip, '192.168.10.1',
		'a non-contiguous netmask leaves the LAN address untouched');
	lib.eq(values.lan_bad_mask_netmask, '255.255.255.0',
		'a non-contiguous netmask is not written');
	lib.eq(values.lan_bad_mask_warning, '1', 'a non-contiguous netmask is reported');

	lib.eq(values.lan_empty_ip_netmask, '255.255.255.0',
		'an empty static address leaves the LAN netmask untouched');
	lib.eq(values.lan_empty_ip_warning, '1', 'an empty static address is reported');
	lib.eq(values.lan_bad_ip_netmask, '255.255.255.0',
		'a malformed static address leaves the LAN netmask untouched');
	lib.eq(values.lan_bad_ip_warning, '1', 'a malformed static address is reported');

	lib.eq(values.lan_static_ip, '192.168.10.112', 'a valid static address is written');
	lib.eq(values.lan_static_netmask, '255.255.255.0', 'a valid static netmask is written');
	lib.eq(values.lan_static_expect_ip, '192.168.10.112',
		'a valid static address is recorded for verification');
	lib.eq(values.lan_static_expect_mask, '255.255.255.0',
		'a valid static netmask is recorded for verification');
	lib.eq(values.lan_static_expect_gw, '192.168.10.1',
		'a valid static gateway is recorded for verification');

	lib.eq(values.helper_ipv4_ok, '1', 'a normal IPv4 address is accepted');
	lib.eq(values.helper_ipv4_zero, '0', '0.0.0.0 is not a usable address');
	lib.eq(values.helper_ipv4_leading, '0', 'an octet with a leading zero is refused');
	lib.eq(values.helper_ipv4_short, '0', 'an incomplete IPv4 address is refused');
	lib.eq(values.helper_ipv4_high, '0', 'an octet above 255 is refused');
	lib.eq(values.helper_ipv4_empty, '0', 'an empty address is refused');
	lib.eq(values.helper_mask_24, '1', 'a /24 netmask is accepted');
	lib.eq(values.helper_mask_32, '1', 'a /32 netmask is accepted');
	lib.eq(values.helper_mask_noncontig, '0', 'a non-contiguous netmask is refused');
	lib.eq(values.helper_mask_zero, '0', 'a /0 netmask is refused');
	lib.eq(values.helper_mask_host, '0', 'a netmask ending in a host bit is refused');
	lib.eq(values.helper_prefix_24, '24', 'a /24 netmask converts to 24');
	lib.eq(values.helper_prefix_8, '8', 'a /8 netmask converts to 8');
	lib.eq(values.helper_prefix_32, '32', 'a /32 netmask converts to 32');
	lib.eq(values.helper_prefix_30, '30', 'a /30 netmask converts to 30');

	lib.eq(values.lan_rollback_rc, '1', 'a broken static apply fails the check');
	lib.eq(values.lan_rollback_proto, 'static', 'rollback restores the LAN proto');
	lib.eq(values.lan_rollback_ip, '192.168.10.1', 'rollback restores the LAN address');
	lib.eq(values.lan_rollback_netmask, '255.255.255.0', 'rollback restores the LAN netmask');
	lib.eq(values.lan_rollback_gateway, 'UNSET', 'rollback removes the added gateway');
	lib.eq(values.lan_rollback_state, 'no', 'rollback clears the verification snapshot');
	lib.eq(values.lan_rollback_warning, '1', 'rollback is reported');

	lib.eq(values.lan_healthy_rc, '0', 'a healthy static apply passes the check');
	lib.eq(values.lan_healthy_ip, '192.168.10.112', 'a healthy address is kept');
	lib.eq(values.lan_healthy_state, 'no', 'a healthy apply clears the snapshot');
	lib.eq(values.lan_healthy_message, '1', 'a healthy address is reported');

	lib.eq(values.lan_no_gw_rc, '1', 'a missing default route fails the check');
	lib.eq(values.lan_no_gw_ip, '192.168.10.1',
		'a missing default route rolls the LAN address back');
	lib.eq(values.lan_no_gw_warning, '1', 'a missing default route is reported');

	lib.eq(values.rdns_first, 'client-192.168.10.20',
		'a reverse lookup resolves the client name');
	lib.eq(values.rdns_second, 'client-192.168.10.20',
		'a cached reverse lookup returns the same name');
	lib.eq(values.rdns_calls, '1', 'a cached reverse lookup does not ask again');
	lib.eq(values.rdns_cached, '1', 'the resolved name is stored in the cache');

	lib.eq(values.rdns_expired, 'client-192.168.10.30',
		'an expired cache entry is looked up again');
	lib.eq(values.rdns_expired_calls, '2', 'the expired entry causes a new lookup');

	lib.eq(values.rdns_none_first, '', 'an unknown address has no name');
	lib.eq(values.rdns_none_second, '', 'a cached negative answer has no name');
	lib.eq(values.rdns_none_calls, '3',
		'a negative reverse lookup is cached and not repeated');
	lib.eq(values.rdns_none_cached, '1', 'the negative answer is stored in the cache');

	lib.eq(values.backup_created_exists, 'yes',
		'backup create writes the new archive');
	lib.eq(values.backup_count, '20',
		'backup create keeps only the newest archives');
	lib.eq(values.backup_oldest_kept, 'yes',
		'the newest archive beyond the retention limit is kept');
	lib.eq(values.backup_oldest_gone, 'yes',
		'the oldest archive beyond the retention limit is removed');

	lib.eq(values.linkinfo_stopped, '0', 'linkinfo reports a stopped mesh');
	lib.eq(values.linkinfo_running, '1', 'linkinfo reports a running mesh');

	lib.eq(values.clients_active, '-51',
		'a station with recent traffic keeps its signal');
	lib.eq(values.clients_stale, '',
		'a station inactive longer than the limit is left out');

	if (!stdout.includes('server1_'))
		lib.ok(false, 'harness produced output');

	lib.summary('script');
}

run();
