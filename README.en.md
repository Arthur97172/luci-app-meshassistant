# Easy Mesh (luci-app-meshassistant)

[简体中文](README.md) | English

A Batman-adv mesh configuration page for OpenWrt / ImmortalWrt. Pick a role,
fill in the SSID and password, and click a button to turn the device into a mesh
server, node or client — the page also shows the current neighbor status. The
whole frontend is written in JavaScript and does not depend on `luci-compat`,
`luci-lua-runtime` or `libiwinfo-lua`.

The package lives under **Network → Easy Mesh**
(`admin/network/meshassistant`; the Chinese interface calls it
**网络 → MESH助手**) and the page title is **Easy Mesh WiFi Setup**.

## Features

| Feature | Description |
| --- | --- |
| Three roles | Server (gateway), Node and Client |
| Regular AP + mesh backhaul | Separate radios for the regular WiFi AP and the mesh backhaul; select only one mesh radio with the current script |
| Wired backhaul | Optionally dedicate one LAN port to the mesh: wired is used while the cable is connected, and the mesh radio takes over when it is not |
| Mesh status | Reads `batctl n` and shows the active node count, interface, neighbor node and last-seen time |
| Background apply | The script detaches from the page, so a WiFi / network restart cannot time out the request or drop the browser |
| Dumb AP mode | Turns a node into a dumb access point attached to an existing network (changes the management address) |
| DHCP reuse | The server can provide or skip DHCP/IPv6 RA, so an existing LAN DHCP server can stay in charge |
| Internationalization | English and Simplified Chinese; Chinese ships as a separate language pack |
| Light / dark | Follows the LuCI theme automatically, no manual switch |

## Installation

### From Releases

1. Open the [Releases](https://github.com/Arthur97172/luci-app-meshassistant/releases)
   page and download the package for your firmware.
2. Upload it to the device (for example `/tmp`), then install:

   **OpenWrt 24.10 and older (opkg)**

   ```sh
   opkg install /tmp/luci-app-meshassistant_*.ipk

   #Optional, Simplified Chinese language pack:

   opkg install /tmp/luci-i18n-meshassistant-zh-cn_*.ipk
   ```

   **OpenWrt 25.12+ (apk)**

   ```sh
   apk add --allow-untrusted /tmp/luci-app-meshassistant-*.apk

   #Optional, Simplified Chinese language pack:

   apk add --allow-untrusted /tmp/luci-i18n-meshassistant-zh-cn-*.apk
   ```

3. Refresh LuCI; the entry appears under **Network → Easy Mesh**.

> Without the language pack the interface stays in English. The package is
> architecture independent (`all` for ipk, `noarch` for apk), so one artifact
> works on ARM, x86, MIPS and every other platform; dependencies such as
> `batctl` and `kmod-batman-adv` come from the configured package feeds.

### From source

```sh
cd openwrt
./scripts/feeds update -a
./scripts/feeds install -a
git clone https://github.com/Arthur97172/luci-app-meshassistant.git package/luci-app-meshassistant
make menuconfig     # LuCI → Applications → luci-app-meshassistant
make package/luci-app-meshassistant/compile V=s
```

The built packages end up in `bin/packages/<arch>/base/`; both the main package
and `luci-i18n-meshassistant-zh-cn` are produced together.

## Usage

1. Open **Network → Easy Mesh**. The top of the page shows **Mesh Status**;
   below it the **Mesh Settings** form has three tabs: **Basic Setup**,
   **AP Mode** and **Advanced Settings**.
2. Fill in **Basic Setup**:
   - **Enable Mesh Networking**: the master switch, off by default.
   - **Mesh Mode**: Server / Node / Client; see **Mesh mode details** below for
     the behaviour and configuration differences.
   - **Server Provides DHCP**: shown only for the Server role. Keep it enabled
     when the Mesh server is the only gateway and should serve DHCP and IPv6 RA.
     Disable it when another router on the LAN already provides DHCP (for
     example a main router at `192.168.5.1`): the server keeps the gateway and
     DNS role but stops its own DHCP/RA service.
   - **WiFi Network SSID**: the name of the regular WiFi access point.
   - **Regular AP Radio**: the radio that carries the regular WiFi.
   - **Mesh Radio**: the radio that carries mesh backhaul traffic. This is a
     single-select field; a multi-value setting left by an older version is
     rejected by the script.
   - **Wired Backhaul Port**: optionally dedicate a LAN port cabled to another
     mesh device. The default is **None (wireless backhaul only)**. The port is
     removed from the LAN bridge and attached to `bat0`; select the same kind of
     port at both ends of the cable. See **Wired backhaul** below.
   - **Mesh Network SSID**: must be identical on every device in the mesh.
   - **Password Protection / Mesh Password**: when enabled, the regular AP uses
     WPA3 mixed mode (`sae-mixed`) and the mesh backhaul uses WPA3 (`sae`); the
     password needs at least 8 characters.
3. **AP Mode** appears only for the Node and Client roles:
   - **Node Hostname**: `node2` – `node9`.
   - **IP Mode / Static IP Address / Mesh Gateway IP Address / IPv4 netmask /
     DNS Server**: filled in when static IP mode is selected.
   - **Enable Dumb AP Mode**: see the warning below.
   - These IP Mode / hostname settings are applied on a **normal enable** too;
     the previous LAN and hostname values are backed up and restored when the
     mesh is disabled.
4. **Advanced Settings** contains the K/V/R switch, the mobility domain
   (4 hexadecimal digits) and the good / bad RSSI thresholds. Leave these at
   their defaults unless you know what you are doing.
5. Click **Save & Apply** at the bottom of the page. This only writes the form
   to `/etc/config/meshassistant`; it does **not** change the system network yet.
6. Click **Reapply meshassistant Settings** to make the script create or remove
   the mesh interfaces from the saved configuration. The button works on saved
   values, so save first; output goes to `/tmp/meshassistant.log`. Reapplying a
   node also applies the AP Mode LAN address / hostname. With the master switch
   off, the same button cleans up the created mesh interfaces, deletes the
   Batman network, restores the LAN / hostname / DHCP values it backed up and
   re-enables the services it disabled, then reloads networking.
7. After the apply finishes, reload the page. **Mesh Status** shows the active
   node count, interface, neighbor node and last-seen time. When `batctl`
   output cannot be read, **Unable to read mesh status** is shown instead.

> Applying again after changing the mesh SSID or radios makes the script try to
> clean up the interfaces for both the current and the previously recorded
> mesh SSID.

### Mesh mode details (Server / Node / Client)

The three **Mesh Mode** choices map to different script roles. In a network
with two or more devices, normally one device is the **Server** and the rest
are **Nodes**.

| Item | Server | Node | Client |
| --- | --- | --- | --- |
| Script role | `server` | `off` | `client` |
| `bat0` gateway mode | `server` | `off` | `off` |
| Firewall / DHCP / DNS | kept; DHCP/RA can be turned off | disabled | disabled |
| `bat0` in `br-lan` | yes | yes | yes |
| `wan` port in `br-lan` | no | no (except Dumb AP mode) | no (except Dumb AP mode) |
| AP Mode tab | hidden | shown | shown |
| Internet uplink | required for internet | not required | not required |
| Address assignment | local DHCP server, or another LAN router | DHCP client or static from the AP Mode tab | same as Node |
| Typical use | single gateway / main device | extend mesh coverage | non-gateway mesh member |

**Server**

- Acts as the mesh gateway: the script sets `bat0` to `gw_mode=server`, adds it
  to the LAN bridge, and adds `bat0` to the firewall zone named `lan`.
  `mesh_batman` is a layer-2 hardif without an address, so the script removes it
  from every firewall zone.
- Firewall zones are found by **name** (`lan` / `wan`), not by index, so a
  reordered firewall config is not damaged. The WAN zone keeps its existing
  network list (`wan`, `wan6`, `wwan` or a custom uplink); `wan` is added only
  when the zone is empty. The script also ensures NAT on the WAN zone and a
  `lan → wan` forwarding rule.
- Reapplying keeps `mesh_batman.master='bat0'` and repairs an older
  `mesh_batman` section that is missing `master`.
- By default `dnsmasq`, `firewall` and `odhcpd` stay running; the server
  provides DHCP, DNS and NAT for the whole mesh. With **Server Provides DHCP**
  turned off, the script sets `dhcp.lan.ignore=1`, disables LAN IPv6
  RA/DHCPv6 and stops `odhcpd`, but keeps `dnsmasq` for DNS.
- If the whole mesh needs internet access, the server must have an uplink,
  typically a wired WAN. A `wwan` (WiFi STA) uplink also works; the script no
  longer rewrites the WAN zone's network list.
- There should be exactly one server per mesh.
- The AP Mode tab is hidden. If a regular WiFi AP is still needed, choose a
  **Regular AP Radio** under **Basic Setup**.
- If no regular AP is wanted at all: the page has no **None** option, and the
  script skips the AP only when `wifi_radio` is empty. Over SSH run
  `uci set meshassistant.config.wifi_radio='' && uci commit meshassistant`,
  then `/meshassistant/meshassistant.sh --detach`; do not click **Save & Apply**
  on the page afterwards, or the default radio will be written back. Remove any
  existing `wifi_ap_*` sections manually.

**Node**

- Acts as a mesh extension point: the script sets `bat0` to `gw_mode=off` and
  adds only `bat0` to the LAN bridge. It does **not** delete firewall zones and
  does **not** put the `wan` port into `br-lan` (which would risk looping the
  uplink into the LAN).
- A node disables `firewall`, `dnsmasq` and `odhcpd` if they are enabled, and
  records which services it disabled in the `meshassistant` config. Disabling
  the mesh or switching the role back to Server re-enables them, so the device
  is not left with permanently disabled services.
- The AP Mode tab settings now take effect on a **normal enable**: the script
  applies **IP Mode** (DHCP client, or the static address / gateway / netmask /
  DNS) and **Node Hostname** to the LAN. The original LAN and hostname values
  are backed up first and restored when the mesh is disabled.
- A node provides no DHCP or NAT; clients receive addresses from the server (or
  from an existing LAN DHCP server). When using a static address, give the node
  a non-conflicting address in the same subnet (for example server
  `192.168.10.1`, node `192.168.10.2`).
- A node should not keep a WAN uplink. For the plugin's wired backhaul, select
  the cabled **LAN bridge port** under **Wired Backhaul Port** on both devices
  instead of using the WAN port. If the cable only provides an ordinary LAN
  uplink from another router, leave wired backhaul at **None** and use a normal
  LAN port. If the device used a WiFi STA (`wwan`) for internet, remove or
  disable it on a node so it does not keep a competing default route.
- Multiple nodes are allowed. Every node must use the same **Mesh Network
  SSID** and password as the server.

**Client**

- In the current script, `client` and `off` (Node) take exactly the same code
  path: `bat0` is `gw_mode=off`, only `bat0` joins `br-lan`, the `wan` port is
  left alone, and `firewall` / `dnsmasq` / `odhcpd` are disabled with their
  previous state recorded.
- Its effective configuration is therefore identical to Node; the difference is
  only the UI label. Use **Node** to extend a mesh, and choose **Client** only
  when the original plugin's "client" semantics are needed.
- The AP Mode tab and the Dumb AP button are shown as well; the same caveats as
  Node apply, including the LAN / hostname backup and restore on disable.

**Wired backhaul (optional)**

All three roles support a dedicated wired backhaul. It is configured per device
and is independent of the role:

- Choose **Wired Backhaul Port** on each device that is connected by cable, and
  cable those two ports together. Both ends must be meshassistant devices with a
  wired port selected; the cable must not be connected to a port that is still
  an ordinary LAN port on the other side (see the note below).
- When applied, the script removes the selected port from `br-lan`, marks the
  removal in `wired_backhaul_bridge_removed` / `wired_backhaul_restore_port`,
  and creates `network.mesh_wired` as a `batadv_hardif` with
  `master='bat0'`, `mtu='1500'` and a very high
  `throughput_override='100000mbit'`. BATMAN_V therefore prefers the wired path
  whenever the cable is up. Both wired and wireless hardifs stay configured;
  when the cable is unplugged the wired hardif goes down and traffic continues
  over the mesh radio, and it returns to the wired path when the cable comes
  back.
- The dedicated port no longer carries ordinary LAN traffic. Do not select the
  port used for management or for a plain LAN uplink, or that connection will
  stop working when the settings are applied. If you only need a normal wired
  uplink, leave **Wired Backhaul Port** at **None** and use the port as a normal
  LAN port instead.
- The port must belong to the LAN bridge and must not be used by another logical
  interface such as `wan`. The page only lists LAN bridge ports; if the saved
  port becomes invalid, the script warns in `/tmp/meshassistant.log` and falls
  back to the mesh radio without removing the port.
- The wired hardif keeps a standard 1500-byte MTU. With `fragmentation=1`,
  batman-adv fragments larger frames at layer 2, so no jumbo-frame configuration
  is needed.
- Changing the selection restores the old port to the LAN bridge and dedicates
  the new one. Disabling the mesh restores the dedicated port but keeps the
  saved **Wired Backhaul Port** value for the next enable.

**Minimal two-device example**

- Server: choose **Server**, keep LAN at `192.168.10.1`, and connect the
  internet uplink; select one Mesh Radio (for example `radio0`) and enter the
  Mesh Network SSID and password. Leave **Server Provides DHCP** enabled unless
  another router on the LAN already provides DHCP.
- Node: choose **Node** and open **AP Mode**. Set **IP Mode** to **Static**,
  **Static IP Address** `192.168.10.2`, **Mesh Gateway IP Address**
  `192.168.10.1`, the same netmask, and **DNS Server** `192.168.10.1`. Remove
  or disable the old `wwan` STA, then use exactly the same Mesh Radio, Mesh
  Network SSID and password as the server.
- For wired backhaul, select the cabled LAN port under **Wired Backhaul Port**
  on both devices (for example `lan3` on each side) before applying, and cable
  those two ports together. If no cable is present, leave it at **None**.
- Save and apply the server first, then the node; check `batctl n` or the
  **Mesh Status** section on both devices for a neighbor.

**DHCP reuse example (existing main router already provides DHCP)**

A common home setup has a wired main router at `192.168.5.1` doing PPPoE and
DHCP, with the mesh devices on the same LAN:

| Device | Address | Role | Notes |
| --- | --- | --- | --- |
| Main router | `192.168.5.1` | — | PPPoE, the only DHCP / IPv6 RA server |
| W1700K | `192.168.5.2` | Server | OpenClash / OxiDNS; **Server Provides DHCP** off |
| W1700K | `192.168.5.3` | Node | DHCP client, or static `192.168.5.3` |
| W1700K | `192.168.5.4` | Node | DHCP client, or static `192.168.5.4` |

- All three use the same **Mesh Network SSID** and password; a 5GHz or 6GHz
  radio is recommended for the mesh backhaul, with the other radio for the
  regular AP.
- On the server (`.2`), the Server role keeps its existing LAN address, so the
  AP Mode tab is not needed. Disable **Server Provides DHCP** so `.1` keeps
  handing out addresses; the server still keeps the gateway, firewall and DNS
  role (OpenClash / OxiDNS).
- On each node, use **AP Mode** with **IP Mode: DHCP**, or **Static** with a
  free address in `192.168.5.0/24` and gateway / DNS set to the server
  `192.168.5.2`. Use the same Mesh Radio, Mesh Network SSID and password.
- For wired backhaul between mesh devices, select the cabled LAN port under
  **Wired Backhaul Port** on both ends (for example `.2` and `.3`) and cable
  those dedicated ports together. Never use a WAN port.
- A cable from `.3` to the main router `.1` is not a meshassistant wired
  backhaul, because `.1` does not run this plugin: leave **Wired Backhaul Port**
  at **None** and use a normal LAN port there. The mesh still forms over WiFi,
  and that cable simply gives `.3` an ordinary LAN uplink.

> Common requirements: every device must use the same **Mesh Network SSID** and
> password; **Mesh Radio** is single-select (a multi-value setting left by an
> older version is rejected); after changing radios or the mesh SSID, check for
> and remove stale `wifi_ap_*` / `mesh_*` sections.

### Dumb AP mode

**Enable Dumb AP Mode** backs up five configuration files to
`/etc/config/*.meshbak` (`wireless`, `network`, `dhcp`, `system`, `firewall`)
and then:

- disables and stops `firewall`, `dnsmasq` and `odhcpd`;
- switches LAN to the static address from **AP Mode**, or to a DHCP client;
- deletes `wan` / `wan6` and adds the `wan` port to `br-lan`;
- rewrites the firewall zones, disables LAN DHCP and writes the hostname into
  `system`.

The management address may therefore change and **the current page will lose
its connection** — that is what the warning text on the button means. The
button is only shown for the Node and Client roles.

To undo it, log in over SSH and run

```sh
bash /meshassistant/meshassistant.sh undumb
```

The current configuration is moved to `/etc/config/*.dumbap` for reference, the
`*.meshbak` files are restored and the disabled services are re-enabled.

## How it works

The frontend reads UCI and `batctl n` status, writes the form to
`/etc/config/meshassistant`, and executes `/meshassistant/meshassistant.sh`
through RPC. The browser never assembles shell commands; what may be executed
is limited precisely by the rpcd ACL (see **Safety notes**).

`/meshassistant/meshassistant.sh` is the script that performs the real
configuration, running as root:

- Every call from the page uses `--detach`: the script immediately re-launches
  itself in the background, redirects output to `/tmp/meshassistant.log` and
  returns before WiFi / networking restarts, so the RPC call cannot time out.
- **Enabling** (`enabled=1`): it first tries to clean up the interfaces for the
  current and the previously recorded mesh SSID, creates `network.bat0`
  (`batadv`, BATMAN_V) and `network.mesh_batman` (`batadv_hardif`), then
  configures the selected mesh radio:
  - Regular AP: creates `wireless.wifi_ap_<radio>`, mode `ap`, SSID from
    **WiFi Network SSID**, network `lan`, with 802.11r and the mobility domain;
  - Mesh backhaul: creates `wireless.mesh_<radio>`, mode `mesh` (802.11s); the
    actual `mesh_id` is the **Mesh Network SSID** with a `-mesh` suffix,
    attached to `mesh_batman`;
  - after each interface a `wifi reload` runs; the script finally restarts
    networking and wireless.
- **Server** role: `bat0` gets `gw_mode=server` and joins the `br-lan` bridge.
  Firewall zones are looked up by name: `bat0` is added to the `lan` zone and
  `mesh_batman` (a layer-2 hardif with no address) is removed from every zone.
  The `wan` zone keeps its existing network list (for example `wwan`), gets
  `masq=1` and a named `lan → wan` forwarding rule. With **Server Provides
  DHCP** off, `dhcp.lan` is set to `ignore=1` with RA/DHCPv6 disabled and
  `odhcpd` is stopped, while `dnsmasq` stays up for DNS.
- **Node / Client** role: `bat0` gets `gw_mode=off` and only `bat0` is added to
  `br-lan`; the `wan` port is not touched. The LAN address and hostname from
  the AP Mode tab are applied after backing up the previous values, and
  `firewall`, `dnsmasq` and `odhcpd` are disabled with their prior state
  recorded. Both roles follow the same code path in the script.
- **Wired backhaul** (any role, when a port is selected): the script validates
  that the port is a LAN bridge port not owned by another interface, removes it
  from `br-lan`, records the removal, and creates `network.mesh_wired`
  (`batadv_hardif`, `master=bat0`, `device=<port>`, `mtu=1500`,
  `throughput_override=100000mbit`). The high throughput override makes BATMAN_V
  prefer the wired link while it is up; the mesh radio remains configured and
  is used automatically when the wired hardif goes down.
- **Disabling** (`enabled=0`): removes the mesh / AP interfaces for the current
  and previously recorded SSID, removes `mesh_wired` and returns its port to
  `br-lan`, deletes `bat0` and `mesh_batman`, takes `bat0` out of the LAN
  bridge, restores the backed-up LAN address, hostname and `dhcp.lan` values,
  re-enables the services it disabled and reloads networking. It only undoes
  changes the script recorded as its own.

The package ships no init script. Installation only runs the uci-defaults
script, which creates the default configuration (`enabled=0`) without applying
mesh settings; upgrading and rebooting never change the network on their own.
Only the buttons on the page invoke the configuration script.

## Mesh status

The status area reads `/usr/sbin/batctl n` through RPC. The parser understands
both output formats:

- BATMAN_V: `neighbor last-seen (speed) [interface]`
- BATMAN_IV: `interface neighbor last-seen`

Header lines never match the data patterns. When `batctl` is missing, the
command fails or it returns a non-zero code, the page shows **Unable to read
mesh status** instead of treating the failure as zero nodes.

## Themes and compatibility

- Works in both the light and the dark variant of the LuCI theme with no manual
  switch: the page contains no custom CSS, inline colors or theme detection. It
  uses only existing LuCI structures such as `cbi-*`, `.table` and
  `.alert-message`, so the theme's own CSS variables decide the appearance.
- Adapted to `luci-theme-bootstrap` (the default in OpenWrt 24.10 / 25.12) and
  to `luci-theme-argon` 2.x / 3.x; menu titles are translated by the theme's
  menu script.
- Compatible with the JavaScript LuCI of OpenWrt / ImmortalWrt 24.10 and 25.12;
  no `luci-compat` is required.
- Language: English by default. After installing
  `luci-i18n-meshassistant-zh-cn`, the menu shows **MESH助手** and the page
  switches to Simplified Chinese.

## Safety notes

- The rpcd ACL is exact to the command line: only `/usr/sbin/batctl n` and the
  two commands `/meshassistant/meshassistant.sh --detach` and
  `/meshassistant/meshassistant.sh --detach dumbap` may be executed; arbitrary
  arguments are not accepted.
- UCI permissions: `meshassistant`, `network` and `wireless` are readable, only
  `meshassistant` is writable. The page reads `network` solely to offer the LAN
  bridge ports for wired backhaul. Changes to `network`, `firewall`, `dhcp` and
  `system` happen inside the root script, never through the browser.
- The default configuration is `enabled=0`; installing and booting never touch
  the network.
- Normal Server / Node use is reversible: before changing anything the script
  records the original LAN (`lan_state_saved`, `lan_backup_*`), hostname
  (`hostname_state_saved`, `hostname_backup`), `dhcp.lan`
  (`dhcp_lan_saved`, `lan_ignore_backup`, `lan_ra_backup`,
  `lan_dhcpv6_backup`) and disabled services (`disabled_<service>`) in
  `/etc/config/meshassistant`. Disabling the mesh restores exactly those values
  and re-enables those services. It never deletes firewall zones and only
  removes `bat0` from a zone or the forwarding rule that it recorded adding.
- Wired backhaul is reversible too: before removing a port from `br-lan` the
  script records `wired_backhaul_bridge_removed=1` and
  `wired_backhaul_restore_port=<port>`. Disabling the mesh (or changing the
  selected port) puts the port back into the LAN bridge and clears both keys.
- Dumb AP mode is destructive: it changes the management address, removes WAN
  and disables the firewall and DHCP services. Five configuration files are
  backed up first, and `undumb` can restore them.
- The script log lives at `/tmp/meshassistant.log` and may contain SSIDs,
  hostnames and network settings; clean it up as needed.
- The plugin opens no ports or services beyond the LuCI management interface
  itself.

## Local testing and design notes

The test scripts and design notes are kept locally in `tests/` and `docs/` and
are **not included in the published repository**. The published repository keeps
the runtime code, translations, build configuration, CI workflow and the
necessary documentation and license files.

CI (`.github/workflows/build.yml`) builds with the 24.10 (ipk) and 25.12 (apk)
SDKs, and fails if either the main package or the Chinese language pack is
missing. It also checks the package URL and maintainer metadata.

## Files

```
.
├── .gitignore
├── Makefile
├── htdocs/luci-static/resources/
│   ├── view/meshassistant.js
│   └── meshassistant/utils.js
├── po/
│   ├── templates/meshassistant.pot
│   └── zh_Hans/meshassistant.po
├── root/
│   ├── etc/uci-defaults/luci-meshassistant
│   ├── meshassistant/meshassistant.sh
│   └── usr/share/
│       ├── luci/menu.d/luci-app-meshassistant.json
│       └── rpcd/acl.d/luci-app-meshassistant.json
└── .github/workflows/build.yml
```

> `tests/` and `docs/` exist only in the local development environment. They are
> listed in `.gitignore` and are not published with the repository.

## Requirements

- OpenWrt or ImmortalWrt 24.10 or 25.12 with JavaScript-based LuCI
  (`luci-base`)
- `kmod-batman-adv`, `batctl-default`, `luci-proto-batman-adv`: the Batman-adv
  kernel module, command-line tool and protocol support
- `kmod-cfg80211`: wireless configuration support
- `dawn`: the 802.11k/v/r roaming daemon
- `bash`: the configuration script is written in bash
- At least one radio supporting 802.11s mesh; a dual-band device is recommended,
  using one radio for the regular AP and the other for mesh backhaul

## License

GPL-3.0-only

## Acknowledgements

- This repository was inspired by https://github.com/torguardvpn/luci-app-easymesh and was optimized on top of it.
