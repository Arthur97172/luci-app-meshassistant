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
| Mesh status | Reads `batctl n` and shows the active node count, interface, neighbor node and last-seen time |
| Background apply | The script detaches from the page, so a WiFi / network restart cannot time out the request or drop the browser |
| Dumb AP mode | Turns a node into a dumb access point attached to an existing network (changes the management address) |
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
   - **WiFi Network SSID**: the name of the regular WiFi access point.
   - **Regular AP Radio**: the radio that carries the regular WiFi.
   - **Mesh Radio(s)**: the radio(s) that carry mesh backhaul traffic. Select
     only one for now; the script cannot reliably create multiple mesh
     interfaces when several are selected.
   - **Mesh Network SSID**: must be identical on every device in the mesh.
   - **Password Protection / Mesh Password**: when enabled, the regular AP uses
     WPA3 mixed mode (`sae-mixed`) and the mesh backhaul uses WPA3 (`sae`); the
     password needs at least 8 characters.
3. **AP Mode** appears only for the Node and Client roles:
   - **Node Hostname**: `node2` – `node9`.
   - **IP Mode / Static IP Address / Mesh Gateway IP Address / IPv4 netmask /
     DNS Server**: filled in when static IP mode is selected.
   - **Enable Dumb AP Mode**: see the warning below.
4. **Advanced Settings** contains the K/V/R switch, the mobility domain
   (4 hexadecimal digits) and the good / bad RSSI thresholds. Leave these at
   their defaults unless you know what you are doing.
5. Click **Save & Apply** at the bottom of the page. This only writes the form
   to `/etc/config/meshassistant`; it does **not** change the system network yet.
6. Click **Reapply meshassistant Settings** to make the script create or remove
   the mesh interfaces from the saved configuration. The button works on saved
   values, so save first; output goes to `/tmp/meshassistant.log`. With the
   master switch off, the same button tries to clean up the created mesh
   interfaces, deletes the Batman network and reloads networking.
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
| Firewall / DHCP / DNS | kept and active | disabled | disabled |
| `bat0` in `br-lan` | yes | yes | yes |
| `wan` port in `br-lan` | no | yes | yes |
| AP Mode tab | hidden | shown | shown |
| Internet uplink | required for internet | not required | not required |
| Address assignment | local DHCP server | server or static | server or static |
| Typical use | single gateway / main device | extend mesh coverage | non-gateway mesh member |

**Server**

- Acts as the mesh gateway: the script sets `bat0` to `gw_mode=server`, adds it
  to `br-lan`, and sets the firewall LAN zone to `lan bat0` and the WAN zone to
  `wan mesh_batman`.
- Keeps `dnsmasq`, `firewall` and `odhcpd` running; the server provides DHCP,
  DNS and NAT for the whole mesh.
- If the whole mesh needs internet access, the server must have an uplink,
  typically a wired WAN. If the uplink is `wwan` (for example a WiFi STA), the
  script does not put it back into the WAN firewall zone; after enabling, add
  `wwan` back to the `wan` zone under **Network → Firewall**, otherwise
  internet access may break.
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

- Acts as a mesh extension point: the script sets `bat0` to `gw_mode=off`,
  deletes the firewall zones (`@zone[0]`–`[2]` in sequence), disables
  `firewall`, `dnsmasq` and `odhcpd`, and adds `bat0` and the `wan` port to
  `br-lan`.
- A node provides no DHCP or NAT; clients receive addresses from the server.
  Give the node its own non-conflicting LAN address in the same subnet (for
  example server `192.168.10.1`, node `192.168.10.2`).
- The AP Mode tab is shown, but **Static IP Address / Gateway / Netmask / DNS**
  are only used when **Enable Dumb AP Mode** is clicked. A normal enable does
  not change the LAN address. To set a fixed management address, change LAN
  under **Network → Interfaces** first, or use Dumb AP mode.
- A node should not keep a WAN uplink. If `network.wan` exists, remove it or use
  Dumb AP mode; otherwise the `wan` port would be both a WAN and a `br-lan`
  member. If the device used a WiFi STA (`wwan`) for internet, remove or
  disable it on a node so it does not keep a competing default route.
- Multiple nodes are allowed. Every node must use the same **Mesh Network
  SSID** and password as the server.

**Client**

- In the current script, `client` and `off` (Node) take exactly the same code
  path: `bat0` is `gw_mode=off`, firewall/DHCP/DNS are disabled, and `bat0` and
  `wan` are added to `br-lan`.
- Its effective configuration is therefore identical to Node; the difference is
  only the UI label. Use **Node** to extend a mesh, and choose **Client** only
  when the original plugin's "client" semantics are needed.
- The AP Mode tab and the Dumb AP button are shown as well; the same caveats as
  Node apply.

**Minimal two-device example**

- Server: choose **Server**, keep LAN at `192.168.10.1`, and connect the
  internet uplink; select one Mesh Radio (for example `radio0`) and enter the
  Mesh Network SSID and password.
- Node: choose **Node**, change LAN to `192.168.10.2` (gateway and DNS pointing
  to `192.168.10.1`), and remove or disable the old `wwan` STA; use exactly the
  same Mesh Radio, Mesh Network SSID and password as the server.
- Save and apply the server first, then the node; check `batctl n` or the
  **Mesh Status** section on both devices for a neighbor.

> Common requirements: every device must use the same **Mesh Network SSID** and
> password; select only **one** Mesh Radio (the script cannot reliably create
> multiple mesh interfaces when several are selected); after changing radios or
> the mesh SSID, check for and remove stale `wifi_ap_*` / `mesh_*` sections.

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
  configures every selected mesh radio:
  - Regular AP: creates `wireless.wifi_ap_<radio>`, mode `ap`, SSID from
    **WiFi Network SSID**, network `lan`, with 802.11r and the mobility domain;
  - Mesh backhaul: creates `wireless.mesh_<radio>`, mode `mesh` (802.11s); the
    actual `mesh_id` is the **Mesh Network SSID** with a `-mesh` suffix,
    attached to `mesh_batman`;
  - after each interface a `wifi reload` runs; the script finally restarts
    networking and wireless.
- **Server** role: `bat0` gets `gw_mode=server` and joins the `br-lan` bridge;
  the firewall LAN zone contains `lan bat0` and the WAN zone contains
  `wan mesh_batman`.
- **Node / Client** role: `bat0` gets `gw_mode=off`, the firewall zones are
  deleted (`@zone[0]`–`[2]` in sequence), `bat0` and `wan` are added to
  `br-lan`, and `dnsmasq`, `firewall` and `odhcpd` are disabled and stopped.
  Both roles follow the same code path in the script.
- **Disabling** (`enabled=0`): tries to remove the mesh / AP interfaces for the
  current and previously recorded SSID, deletes `bat0` and `mesh_batman`, and
  reloads networking. It does not restore other settings from before the mesh
  was enabled.

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
- UCI permissions: `meshassistant` and `wireless` are readable, only
  `meshassistant` is writable. Changes to `network`, `firewall`, `dhcp` and
  `system` happen inside the root script, never through the browser.
- The default configuration is `enabled=0`; installing and booting never touch
  the network.
- Dumb AP mode is destructive: it changes the management address, removes WAN
  and disables the firewall and DHCP services. Five configuration files are
  backed up first, and `undumb` can restore them.
- The script log lives at `/tmp/meshassistant.log` and may contain SSIDs,
  hostnames and network settings; clean it up as needed.
- The plugin opens no ports or services beyond the LuCI management interface
  itself.

## Local testing and design notes

The test scripts and design notes are kept locally in `tests/` and `docs/` and
are **not included in the published repository**. The published repository
contains only runtime code, translations, build configuration and the CI
workflow.

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
