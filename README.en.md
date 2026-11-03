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
| Regular AP + mesh backhaul | Separate radios for the regular WiFi AP and the mesh backhaul; the mesh radio is single-select |
| Wired backhaul | Optionally dedicate one LAN port to the mesh: wired is used while the cable is connected, and the mesh radio takes over when it is not |
| Mesh status | Reads `batctl n` plus the Batman-adv translation table and DAT cache, and shows the active node count, interface, neighbor nodes, the IP addresses of each neighbor and its clients, and the last-seen time |
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
   Regular AP Radio, Mesh Radio, Mesh Network SSID and password. Every device
   must use the same mesh radio, mesh SSID and password.
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
| Internet uplink | required for internet | not required | not required |
| Typical use | single gateway / main device | extend mesh coverage | non-gateway mesh member |

**Client** and **Node** take exactly the same code path in the current script;
the effective configuration is identical and only the UI label differs. Use
**Node** to extend a mesh.

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

- **Server**: exactly one server per mesh. It needs a WAN or other uplink if the
  mesh should reach the internet. Disable **Server Provides DHCP** when another
  router on the LAN already provides DHCP.
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
  switch: the page contains no custom CSS, inline colors or theme detection. It
  uses only existing LuCI structures such as `cbi-*`, `.table` and
  `.alert-message`.
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
