# Mesh Assistant (luci-app-meshassistant)

[简体中文](README.md) | English

A Batman-adv mesh configuration page for OpenWrt / ImmortalWrt. Pick a role,
fill in the SSID and password, and click a button to turn the device into a mesh
server, node or client — the page also shows the current neighbor status. The
whole frontend is written in JavaScript and does not depend on `luci-compat`,
`luci-lua-runtime` or `libiwinfo-lua`.

The package lives under **Network → Mesh Assistant**
(`admin/network/meshassistant`; the Chinese interface calls it
**网络 → MESH助手**) and the page title is **Mesh Assistant WiFi Setup**.

> **Detailed guide**: role differences, when a Node/Client needs a static IP,
> DHCP reuse, wired backhaul, Dumb AP mode, troubleshooting, and complete
> examples with 2–3 wireless routers are in
> [info/README.en.md](info/README.en.md) (English) /
> [info/README.md](info/README.md) (简体中文).

## Features

| Feature | Description |
| --- | --- |
| Three roles | Server (gateway), Node and Client |
| Regular AP + mesh backhaul | The regular WiFi can use up to two of 2.4 GHz, 5 GHz and 6 GHz with the same SSID, while the mesh backhaul picks its own radio; the mesh radio is single-select |
| MLO | With two regular AP radios, MLO combines them into a single Wi-Fi 7 multi-link access point; the selected radios are switched to EHT mode |
| Wired backhaul | Optionally dedicate one LAN port to the mesh: wired is used while the cable is connected, and the mesh radio takes over when it is not |
| Mesh status | Reads `batctl n`, `iw` plus the Batman-adv translation table and DAT cache, and shows the active node count plus the remote and local host rows: interface, node MAC, the IP addresses of each neighbor and its clients, signal strength, load, channel utilization, link rate and the last-seen time |
| Background apply | The script detaches from the page and only performs non-destructive network/wireless reloads, so the request cannot time out or drop the browser |
| Dumb AP mode | Turns a node into a dumb access point attached to an existing network (changes the management address; asks for confirmation first) |
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

3. Refresh LuCI; the entry appears under **Network → Mesh Assistant**.

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

## Quick start

1. Open **Network → Mesh Assistant** and decide whether this device is the
   **Server** or a **Node**. There should be exactly one server per mesh.
2. In **Basic Setup**, choose the role and fill in the WiFi Network SSID,
   Regular AP Radio, Mesh Radio, Mesh Network SSID and password. The Regular AP
   Radio field accepts up to two of 2.4 GHz, 5 GHz and 6 GHz; all selected
   radios use the same WiFi Network SSID. With two radios selected, **Enable
   MLO** combines them into a single Wi-Fi 7 multi-link access point (the
   radios switch to EHT mode). Every device must use the same mesh radio,
   mesh SSID and password.
3. For a Node or Client, open **AP Mode** and set the hostname and IP: use DHCP
   when a DHCP server exists on the LAN, or a static IP when there is none or
   you need a stable management address.
4. For wired backhaul, select the connected LAN bridge port under **Wired
   Backhaul Port** on both ends of the cable; keep **None** for wireless-only
   backhaul.
5. Click **Save & Apply**, then **Reapply meshassistant Settings**. Configure
   the server before the nodes; the log is at `/tmp/meshassistant.log`.
6. Refresh the page and check **Mesh Status** for neighbor nodes.

The detailed field reference, address planning, static-IP rules and
troubleshooting steps are in [info/README.en.md](info/README.en.md).

## Mesh mode overview

| Item | Server | Node | Client |
| --- | --- | --- | --- |
| Script role | `server` | `off` | `client` |
| `bat0` gateway mode | `server` | `off` | `off` |
| Firewall / DHCP / DNS | kept; DHCP/RA can be turned off | disabled (recorded and restored on disable) | disabled (same as Node) |
| `bat0` in `br-lan` | yes | yes | yes |
| `wan` port in `br-lan` | no | no (except Dumb AP mode) | no (except Dumb AP mode) |
| AP Mode tab | hidden | shown | shown |
| Internet uplink | required (WAN or LAN port) | not required | not required |
| Typical use | single gateway / main device | extend mesh coverage | non-gateway mesh member |

**Client** and **Node** take exactly the same code path in the current script;
the effective configuration is identical and only the UI label differs. Use
**Node** to extend a mesh.

## Server uplink

The mesh joins the server, its nodes and clients into one layer-2 segment: on
each of them `br-lan` contains the local LAN ports, the regular AP and `bat0`,
and both wired and wireless backhaul interfaces are attached to `bat0`. So
whether the server connects to the upstream through its WAN port or through one
of its LAN ports, **the LAN ports of the server, its nodes and its clients all
reach the internet**, with either wired or wireless backhaul.

- **Mode A: WAN uplink (router mode)**. The upstream router or modem connects
  to the server's WAN port. The server keeps its firewall and NAT, uses a
  separate static LAN subnet (for example `192.168.10.1/24`) and **Server
  Provides DHCP** is on. Nodes/clients join that subnet by DHCP or a static
  address with gateway and DNS pointing at the server. A device on any LAN port
  or regular WiFi gets a `192.168.10.x` lease, reaches the server over `bat0`
  at layer 2, and the server NATs it to the internet.
- **Mode B: LAN uplink (DHCP reuse)**. The main router's LAN connects to one of
  the server's LAN ports, which stays in `br-lan`. The server LAN uses an
  address in the upstream subnet (static `192.168.5.2/24` or a DHCP client,
  gateway/DNS pointing at the main router) and **Server Provides DHCP** is off.
  Nodes/clients join the main router's subnet by DHCP or a static address. The
  whole mesh is a layer-2 extension of the main router: the main router leases
  addresses and routes/NATs the traffic, and the server does not NAT.
- Either mode has exactly one DHCP server. The WAN ports of nodes/clients are
  unused and must not be connected to another uplink, or a second default route
  appears. In mode B the server itself still needs a default gateway pointing at
  the main router, and the LAN port cabled to the main router must not be used as
  the wired backhaul port.

Field-level details and topology diagrams are in
[section 3 of info/README.en.md](info/README.en.md#3-server-uplink-modes-and-per-role-configuration-details).

## Wired backhaul

All three roles support an optional dedicated wired backhaul:

- Select **Wired Backhaul Port** on both devices at the ends of the cable and
  connect those two ports. Both ends must be mesh devices running this plugin.
- The port must be a LAN bridge port. It must not be a WAN port, nor the
  management or ordinary LAN uplink port; once applied it is removed from
  `br-lan` and dedicated to mesh backhaul.
- Wired is preferred while the cable is connected; when it is unplugged,
  traffic automatically moves to the mesh radio, and it returns to wired when
  the cable comes back.
- If you only need a normal wired uplink, keep **Wired Backhaul Port** at
  **None** and use the port as an ordinary LAN port.

## Important notes

- **Server**: exactly one server per mesh. It can reach the upstream through its
  WAN port (the server NATs and provides DHCP) or through a LAN port (DHCP
  reuse: the main router NATs and provides DHCP, and **Server Provides DHCP**
  must be off). See [Server uplink](#server-uplink).
- **Node / Client**: no DHCP or NAT is provided. Use a static IP in **AP Mode**
  when there is no DHCP server or you need a fixed management address. Remove
  or disable any old `wwan` STA so the node does not keep a competing default
  route.
- **Dumb AP mode** changes the management address, removes WAN and disables the
  firewall and DHCP services. The button asks for confirmation first. Back up
  the configuration and make sure you have physical access; undo it with
  `bash /meshassistant/meshassistant.sh undumb`.
- **Reversible**: enabling/disabling the mesh, wired backhaul ports and node
  LAN/hostname values are backed up and restored. Installing or booting never
  changes the network; the default configuration is `enabled=0`.

## How it works and safety

The frontend reads UCI and `batctl n`, writes the form to
`/etc/config/meshassistant`, and executes `/meshassistant/meshassistant.sh`
through RPC. The browser never assembles shell commands; the rpcd ACL permits
only `/usr/sbin/batctl n`, `/meshassistant/meshassistant.sh --detach` and
`/meshassistant/meshassistant.sh --detach dumbap`. UCI access is read-only for
`network` and `wireless`, and write access is limited to `meshassistant`; all
changes to `network`, `firewall`, `dhcp` and `system` happen inside the root
script.

The script runs with `--detach` in the background so a WiFi/network restart
cannot time out the RPC call. The server sets `bat0` to `gw_mode=server` and
adds it to the LAN bridge; nodes/clients set `bat0` to `gw_mode=off`, disable
`firewall`, `dnsmasq` and `odhcpd`, and record that state for restoration.
Disabling the mesh only undoes changes the script recorded as its own.

## Themes and compatibility

- Works in both the light and dark variant of the LuCI theme with no manual
  switch: the page contains no custom colors or theme detection. It uses only
  existing LuCI structures such as `cbi-*`, `.table` and `.alert-message`.
- Adapted to `luci-theme-bootstrap` (the default in OpenWrt 24.10 / 25.12) and
  to `luci-theme-argon` 2.x / 3.x.
- Compatible with the JavaScript LuCI of OpenWrt / ImmortalWrt 24.10 and 25.12;
  no `luci-compat` is required.
- Language: English by default. After installing
  `luci-i18n-meshassistant-zh-cn`, the menu shows **MESH助手** and the page
  switches to Simplified Chinese.

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
