# Mesh Assistant Detailed Configuration Guide

English | [简体中文](README.md)

This guide explains how to build a mesh with luci-app-meshassistant: how to choose roles and addresses, when a Node or Client needs a static IP, how wired and wireless backhaul work together, and three complete examples with 2–3 wireless routers. For installation and a feature overview, see the [project home page](../README.en.md).

> Everything here matches the fields on the page and the actual behaviour of the script. The shell commands are for checking status and emergency recovery only; use the LuCI page for day-to-day configuration.

## Contents

- [1. Before you start](#1-before-you-start)
- [2. Page fields and workflow](#2-page-fields-and-workflow)
- [3. Server uplink modes and per-role configuration details](#3-server-uplink-modes-and-per-role-configuration-details)
- [4. When a Node / Client needs a static IP](#4-when-a-node--client-needs-a-static-ip)
- [5. Configuring wired backhaul](#5-configuring-wired-backhaul)
- [6. Dumb AP mode](#6-dumb-ap-mode)
- [7. Verification and troubleshooting](#7-verification-and-troubleshooting)
- [8. Mesh examples](#8-mesh-examples)
- [9. Disabling, rolling back and recovery](#9-disabling-rolling-back-and-recovery)
- [10. Backup management](#10-backup-management)

## 1. Before you start

### 1.1 Hardware and firmware

- Every device runs OpenWrt / ImmortalWrt 24.10 or 25.12 with JavaScript-based LuCI.
- Install `luci-app-meshassistant`, plus `kmod-batman-adv`, `batctl-default`, `luci-proto-batman-adv`, `kmod-cfg80211`, `dawn` and `bash`.
- At least one radio must support 802.11s mesh. A dual-band device is recommended: use one radio for the regular AP and the other exclusively for mesh backhaul, so regular WiFi and backhaul do not compete for airtime on the same radio.

### 1.2 Plan the topology

Decide these five things before configuring anything:

| Item | Description |
| --- | --- |
| Roles | Exactly one **Server** per mesh; every other device is a **Node**. **Client** behaves the same as Node in the current script. |
| Uplink | The server connects to the upstream through its WAN port (the server NATs), or through a LAN port (the main router NATs and provides DHCP); see [section 3](#3-server-uplink-modes-and-per-role-configuration-details) |
| Management addresses | Server address, each node address, netmask, gateway and DNS |
| Mesh radio | The same radio on every device (for example `radio0` or `radio1`) |
| Backhaul | Wireless only, or dedicated wired backhaul between some devices |

### 1.3 Back up the configuration

Over SSH on every device:

```sh
mkdir -p /root/mesh-backup
cp /etc/config/network /etc/config/wireless /etc/config/dhcp \
   /etc/config/firewall /etc/config/system /root/mesh-backup/
```

The plugin also provides the **Backup Management** tab (see
[section 10](#10-backup-management)), which creates and restores complete tar
snapshots and saves one automatically before **Save & Apply**. It additionally
records and restores the LAN, hostname and DHCP settings it changes while the
mesh is enabled. The manual copy above is mainly for power loss, mistakes or a
full reinstall.

### 1.4 Management connection

Applying settings restarts networking and wireless. Therefore:

- Prefer a wired connection to a port that will **not** be removed from the LAN bridge;
- Do not manage the device over the WiFi or the port that is about to be reconfigured;
- After changing a node to a static IP, a browser connected through the old address will drop; reconnect at the new address.

## 2. Page fields and workflow

Menu entry: **Network → Mesh Assistant** (Chinese: **网络 → MESH助手**).

### 2.1 Basic Setup

| Field | Purpose |
| --- | --- |
| Enable Mesh Networking | Master switch. Saving only writes the form; click **Reapply meshassistant Settings** to apply it. |
| Mesh Mode | Server / Node / Client. |
| Server Provides DHCP | Server only. When enabled, the server provides DHCP and IPv6 RA. Disable it when another router on the LAN already provides DHCP. |
| DHCP DNS Server | Server only, shown while **Server Provides DHCP** is on. The IPv4 address sent to clients as DHCP option 6 (for example `1.1.1.1`); when empty, dnsmasq keeps advertising the server itself. Option 6 entries found on the LAN before the apply are recorded in `meshassistant.config` and restored when the mesh is disabled; an invalid IPv4 value leaves the current advertisement untouched and is reported in the run log. |
| WiFi Network SSID | Name of the regular WiFi access point. |
| Regular AP Radio | Radio that carries the regular WiFi. Up to two of 2.4 GHz, 5 GHz and 6 GHz can be selected together, with all selected radios using the same WiFi Network SSID; 6 GHz starts as WPA3-only. |
| Enable MLO | Shown only while exactly two regular AP radios are selected. Combines both radios into a single Wi-Fi 7 multi-link access point; the selected radios are switched to EHT mode, because MLO requires every link to be 802.11be. |
| Mesh Radio | Radio that carries mesh backhaul, single-select. Every device must use the same radio. |
| Wired Backhaul Port | Optional. Select the LAN bridge port cabled to another mesh device; keep **None** for wireless-only backhaul. |
| Mesh Network SSID | Mesh backhaul identifier; must be identical on every device. The actual 802.11s `mesh_id` gets a `-mesh` suffix: entering `MyMesh` makes the over-the-air mesh ID `MyMesh-mesh`. |
| Password Protection | When enabled, the regular WiFi and the mesh backhaul both require a password or authentication. |
| Encryption Type | Security mode of the regular WiFi access points: `WPA2-PSK/WPA3-SAE Mixed Mode` (default), `WPA2-PSK/WPA3-SAE Compatibility Mode`, `WPA3-SAE`, `WPA2-PSK` or `WPA2-EAP (RADIUS)`. Compatibility Mode uses the same WPA2-PSK + WPA3-SAE authentication as the mixed mode but offers the SAE extensions (mandatory PMF, SAE-EXT-KEY, GCMP-256) in the RSNE Override elements, so older clients associate more easily and a Wi-Fi 7 (EHT) radio enables GCMP-256 by default; it fits the MLO setup. The mesh backhaul is not affected and always uses WPA3-SAE, because 802.11s only uses the SAE AKM; a 6 GHz radio allows WPA3 only, so the selected mode is applied in its WPA3 form there (PSK modes become WPA3-SAE, WPA2-EAP becomes WPA3-EAP, an open network becomes OWE; with MLO the whole access point, 6 GHz link included, uses the mapped value). The plugin probes the installed hostapd/wpad build: the menu lists only the usable modes, and a mode written by hand that the build cannot start is downgraded at apply time with a note in the run log (no SAE becomes WPA2-PSK, missing `sae-compat` becomes the mixed mode, no EAP becomes the best PSK mode; an open network skips the 6 GHz radios on a build without OWE). The same probing works on OpenWrt/ImmortalWrt 24.10 (shell network scripts) and 25.x (ucode network scripts). |
| Mesh Password | At least 8 characters. In PSK modes it protects both the regular WiFi and the mesh backhaul; with WPA2-EAP the regular WiFi is authenticated by RADIUS and the password still protects the mesh backhaul. Every device must match. |
| RADIUS Authentication Server / Port / Secret | Shown only for `WPA2-EAP (RADIUS)`. Enter the authentication server address, port (default `1812`) and shared secret; without a server or secret the script falls back to `WPA2-PSK/WPA3-SAE Mixed Mode` and says so in the run log instead of leaving an AP that cannot start. The secret must match the one configured on the server. |

> Every device must use exactly the same **Mesh Radio**, **Mesh Network SSID**, **Password Protection** setting, **Encryption Type** (including the RADIUS settings with WPA2-EAP) and **Mesh Password**. Otherwise no neighbour will appear.

### 2.2 AP Mode (Node / Client only)

| Field | Purpose |
| --- | --- |
| Node Hostname | `node2` – `node9` are suggested (a custom name is also accepted); written to the system hostname so the device is easy to identify in DHCP leases and SSH. Use a different name on each node. |
| IP Mode | `DHCP`: the node's LAN is a DHCP client. `Static`: use the address fields below. A node never provides DHCP. |
| Static IP Address | Node LAN address; must be in the same subnet as the server/gateway and must be unique. |
| Mesh Gateway IP Address | Node's default gateway; normally the server's LAN address. In a DHCP-reuse topology, use the address of the actual internet router. |
| IPv4 netmask | Match the server/main router; commonly `255.255.255.0`. |
| DNS Server | Available in both IP modes. In DHCP mode, leave it empty to use the DNS servers advertised by the DHCP server; a value replaces them completely. In static mode it sets the node's DNS server; when empty, the DNS server the LAN already has is kept. |
| Enable Dumb AP Mode | Converts the node into a dumb AP attached to an existing network. It changes the management address and asks for confirmation first. See [section 6](#6-dumb-ap-mode). |

These settings are not limited to Dumb AP mode: a normal node enable also applies IP Mode and hostname. The previous LAN and hostname values are backed up and restored when the mesh is disabled.

### 2.3 Advanced Settings

**Client Roaming (802.11k/v)** is off by default. When enabled, the AP sections get 802.11k neighbor reports and 802.11v (BSS Transition), and the script writes `/etc/config/dawn` from the **Good / Bad RSSI** values on the page and enables DAWN, so a client whose signal drops is steered to a stronger AP.

Client roaming needs a full wpad build (`wpad-mbedtls`, `wpad-openssl`, `wpad-wolfssl` or a `wpad-mesh-*` variant). The usual `wpad-basic-*` build has no 802.11v (`CONFIG_WNM_AP`): the script then leaves DAWN stopped and logs a warning. Do not set `bss_transition=1` by hand; hostapd refuses to start on an option it was not compiled with.

The **Mesh Status** tab checks the installed wpad build and DAWN: when the device supports 802.11k/v and roaming is still off, it shows a hint that the feature can be enabled; when roaming is on but wpad lacks 802.11v or DAWN is missing, it shows a warning that clients will not be steered. With roaming off, 802.11r fast transition still applies and clients still roam on their own.

The Mobility Domain (four hex digits) is used for 802.11r fast transition and must match on every device. When the option has never been saved, the script derives it from the Mesh SSID, so devices sharing a Mesh SSID also share the domain.

Turning roaming off or removing the package stops and disables DAWN when the plugin had taken it over, and restores the `/etc/config/dawn` found at that point (or removes the generated file when there was none). A DAWN configured by the user is left alone.

### 2.4 Save and apply

1. Click **Save & Apply** at the bottom of the page. The page first archives the current configuration (the state **before** the save) under `/etc/meshassistant/backup`, then writes only `/etc/config/meshassistant`; it does not touch the network.
2. Click **Reapply meshassistant Settings**. The script creates another automatic backup before changing anything, then creates/removes interfaces, changes the LAN, and starts or stops services. Its output goes to `/tmp/meshassistant.log`.
3. Recommended order: **server first, then nodes**. The server forms the mesh gateway; nodes can only join once it exists.
4. Networking and wireless restart during the apply, so the page may disconnect briefly. Reconnect and refresh once the restart has finished.

When a node or client joins in DHCP mode, the script also checks the LAN for an IPv4 lease in the background about 30 seconds after the apply (`MESHASSISTANT_DHCP_WATCHDOG_DELAY` changes the delay; `0` disables the check): the address is recorded in the run log when there is one, and a missing lease is written as a warning and shown as a hint on **Mesh Status**. The check only reports the problem; it does not repair anything.

## 3. Server uplink modes and per-role configuration details

The mesh joins all devices into one layer-2 segment: on the server, a node and a client alike, `br-lan` contains the local LAN ports, the regular AP and `bat0`; the wired and wireless backhaul interfaces are attached to `bat0` as hardifs. Therefore, **whether the server connects to the upstream through its WAN port or through one of its LAN ports, the LAN ports of the server and of its mesh nodes/clients (with either wired or wireless backhaul) are in the same layer-2 domain, and devices plugged into those LAN ports can reach the internet**.

The two modes differ only in who routes/NATs and who hands out DHCP leases.

### 3.1 Layer-2 layout of the three roles

| Role | `br-lan` members | `bat0` gateway mode | Firewall / DHCP / DNS |
| --- | --- | --- | --- |
| Server | LAN ports + regular AP + `bat0` | `server` | running; with a WAN uplink the server does NAT and DHCP |
| Node | LAN ports + regular AP + `bat0` | `off` | disabled (recorded and restored when the mesh is disabled) |
| Client | same as Node | `off` | same as Node |

- The WAN port of a node/client is never added to `br-lan` and is unused in both modes. Do not connect a node's/client's WAN port to another router or modem, or a second default route or a loop will appear (Dumb AP mode is the exception; see [section 6](#6-dumb-ap-mode)).
- The LAN port selected as **Wired Backhaul Port** is removed from `br-lan` and bound to `bat0` as a `batadv_hardif`, carrying only mesh frames. The device's other LAN ports stay in `br-lan` and keep providing layer-2 access to clients.
- Wireless backhaul is provided by the 802.11s `mesh_batman` hardif attached to `bat0`. When both wired and wireless backhaul exist, BATMAN_V automatically picks the better path.

> **Result**: whether a node or client joins over wired or wireless backhaul, its LAN ports and regular WiFi are in the same layer-2 segment as the server (or, in mode B, the upstream main router). A device plugged into any of those LAN ports gets an address by DHCP and reaches the internet.

### 3.2 Mode A: server uplink through the WAN port (router mode)

```text
[Internet] ── upstream router / modem ──WAN── [Server 192.168.10.1]
                                                 │ br-lan: LAN ports + regular AP + bat0
                                                 ~~~~ wireless / wired backhaul ~~~~
                                                 │
                                          [Node / Client 192.168.10.x]
                                                 │ br-lan: remaining LAN ports + regular AP
                                             PCs, TVs and other clients
```

**Server**

| Item | Configuration |
| --- | --- |
| WAN | DHCP client, PPPoE or static address as required by the upstream (Network → Interfaces → WAN) |
| LAN | a separate static subnet, for example `192.168.10.1/24` (Network → Interfaces → LAN) |
| Server Provides DHCP | on (unless another DHCP server exists on the server's LAN) |
| Mesh Mode | Server |

The script keeps the WAN interface; if the firewall `wan` zone has an empty network list, it adds `wan` to that zone, and it ensures `masq=1` and a `lan → wan` forwarding rule. It also adds `bat0` to the firewall `lan` zone. With **Server Provides DHCP** on, `dnsmasq` and `odhcpd` are kept or restored.

**Node / Client**

| Item | Configuration |
| --- | --- |
| Mesh Mode | Node (or Client) |
| IP Mode | DHCP (leased by the server), or Static |
| Static address / gateway / netmask / DNS | for example `192.168.10.2` / `192.168.10.1` / `255.255.255.0` / `192.168.10.1` |
| WAN port | unused |

**Path to the internet**: a device plugged into any LAN port, or joined to the regular WiFi of any device, gets a `192.168.10.x` lease from the server. At layer 2 its traffic crosses `bat0` (over the wireless or wired backhaul) to the server, which NATs it out of the WAN port. IPv6 RA is provided by the server as well (while **Server Provides DHCP** is on).

### 3.3 Mode B: server uplink through a LAN port (DHCP reuse / same-subnet bridging)

```text
[Internet] ── main router 192.168.5.1 (DHCP + IPv6 RA) ──LAN── [Server 192.168.5.2]
                                                                  │ br-lan: one LAN port to the upstream, other LAN ports + regular AP + bat0
                                                                  ~~~~ wireless / wired backhaul ~~~~
                                                                  │
                                                           [Node / Client 192.168.5.x]
                                                                  │ br-lan: remaining LAN ports + regular AP
                                                              PCs, TVs and other clients
```

**Server**

| Item | Configuration |
| --- | --- |
| Uplink | main router LAN → one of the server's LAN ports; that port must stay in `br-lan` and must not be selected as **Wired Backhaul Port** |
| LAN | under Network → Interfaces → LAN, use an address in the upstream subnet: static `192.168.5.2/24` with gateway and DNS `192.168.5.1`, or a DHCP client |
| Server Provides DHCP | **off** (the main router provides DHCP) |
| WAN | unused; this avoids a second default route next to the LAN uplink |
| Mesh Mode | Server |

The script sets `bat0` to `gw_mode=server` and adds it to `br-lan` and to the firewall `lan` zone. With **Server Provides DHCP** off it sets `dhcp.lan.ignore=1`, `ra=disabled` and `dhcpv6=disabled`, and disables `odhcpd`; `dnsmasq` stays enabled for DNS but hands out no leases.

**Node / Client**

- **IP Mode** can be DHCP (the main router leases a `192.168.5.x` address) or Static (for example `192.168.5.3`, gateway/DNS `192.168.5.1`).
- To use DNS or filtering on the server, set the gateway/DNS to `192.168.5.2` and make sure the server forwards traffic to the main router.

**Path to the internet**: the server's `br-lan` is bridged at layer 2 to the main router's LAN through the uplink LAN port, and `bat0` extends that same subnet across the mesh. The main router leases addresses; client traffic goes directly to it at layer 2, and the main router NATs it, so it never passes through the server's routing or NAT. IPv6 RA comes from the main router as well.

> In mode B the server does no NAT, so it still needs a default gateway pointing at the main router (a static gateway or one learned by DHCP); otherwise the server itself cannot reach the internet or update packages.

### 3.4 Requirements common to both modes

- Exactly one server per mesh. Nodes/clients provide no DHCP or NAT and do not route; they must not be connected to any WAN uplink.
- The whole network has exactly one DHCP server: the server in mode A, the main router in mode B. Set **Server Provides DHCP** accordingly.
- Wired and wireless backhaul can be mixed. Backhaul only changes the layer-2 path, not the address plan, and both uplink modes support both kinds of backhaul.
- In mode B, the LAN port cabled to the main router must not be selected as the wired backhaul port; use another pair of dedicated LAN ports when wired backhaul is needed.

## 4. When a Node / Client needs a static IP

### 4.1 What "IP Mode" means on a node

Nodes and Clients do not provide DHCP and do not perform NAT. They disable `firewall`, `dnsmasq` and `odhcpd`, add only `bat0` to `br-lan`, and reach the server at layer 2 through the mesh.

**IP Mode controls where the node's own management address comes from:**

- **DHCP** (default): the script sets the node LAN to a DHCP client. The node must be able to reach a DHCP server on the mesh LAN, normally:
  - a Server role with **Server Provides DHCP** enabled; or
  - another router already on the LAN.

  In DHCP mode the gateway is chosen by the server and cannot be set separately. **DNS Server** is optional: empty keeps the advertised DNS servers, a value replaces them completely (the script sets `list dns` and `peerdns=0`). After the apply the script checks the LAN for a lease and warns in the run log and on **Mesh Status** when there is none.
- **Static**: the script sets the node LAN to a static address using the address, netmask, gateway and DNS you enter.

### 4.2 When to use a static IP

| Situation | Why |
| --- | --- |
| There is no DHCP server on the mesh LAN | The server has **Server Provides DHCP** disabled and there is no other main router. A DHCP-mode node gets no address and loses its management entry point. |
| You need a stable management address | Bookmarks, SSH, monitoring, port forwarding and remote access all prefer a fixed node address. |
| You have several nodes | Assigning `.2`, `.3`, `.4` makes nodes easier to tell apart than searching a lease table. |
| The DHCP pool is small or addresses change often | Avoid losing access when a lease changes. |
| Dumb AP deployment | A dumb AP should normally have a fixed management address. |
| Troubleshooting | A static address removes DHCP as a variable when a node goes unreachable. |

### 4.3 When DHCP is fine

- The server has **Server Provides DHCP** enabled and the node can obtain an address through the mesh;
- or the LAN has a reliable main-router DHCP server;
- and you do not need a fixed address, or are willing to look the node up in the server's lease table.

In DHCP mode, find the node's address under **Status → DHCP Leases** on the server, or in `/tmp/dhcp.leases` over SSH. The node hostname (`node2`, `node3`, …) normally appears in the lease as well, which makes identification easier.

### 4.4 Static IP rules

Assuming the server LAN is `192.168.10.1/24`:

| Field | Example | Rule |
| --- | --- | --- |
| IP Mode | Static | — |
| Static IP Address | `192.168.10.2` | Same subnet as the server, unique, not used by another device. Prefer an address outside the DHCP pool, or add a static lease on the DHCP server. |
| Mesh Gateway IP Address | `192.168.10.1` | The server's LAN address (in a DHCP-reuse topology, the actual internet router). |
| IPv4 netmask | `255.255.255.0` | Match the server/main router. |
| DNS Server | `192.168.10.1` | The server's LAN address; an upstream router or public DNS also works. |
| Node Hostname | `node2` | Unique per node. |

> The page defaults are `192.168.8.3` / `192.168.8.1`. They are examples only and **must be changed to match your real LAN**. If the server LAN is `192.168.10.1` and a node is left at `192.168.8.3`, the node will be unreachable.

### 4.5 Common static-IP mistakes

| Mistake | Consequence | Correct approach |
| --- | --- | --- |
| Address outside the server's subnet | The node is unreachable at layer 3 and the page drops | Use the same subnet as the server |
| Address already in use | Intermittent outages and ARP conflicts | Pick a free address or configure a static lease |
| Gateway set to the node itself or a wrong address | The node cannot reach the management network or the internet | Use the server or upstream router |
| Netmask differs from the server | Some devices become unreachable | Match the server |
| Leaving the default `192.168.8.x` | The node is unreachable | Change it to your real LAN |
| Static address inside the DHCP pool | DHCP may hand the same address to another device | Use an address outside the pool or a static lease |

### 4.6 The server also needs a fixed address

The Server role does not show the AP Mode tab and does not change its LAN through that tab. Before enabling the mesh, set the server LAN to a static address (for example `192.168.10.1/24`) under **Network → Interfaces → LAN**, with the correct gateway and DNS. Otherwise the server address may change with upstream DHCP and the gateway configured on the nodes will become invalid.

## 5. Configuring wired backhaul

Wired backhaul is optional, supported by all three roles, and configured per device.

### 5.1 Requirements

- Both ends of the cable must be mesh devices running this plugin, and both must select their connected port under **Wired Backhaul Port**.
- The selected port must be a **LAN bridge port**. It must not be a WAN port or a port already owned by another logical interface.
- Do not select the management port or an ordinary LAN uplink port as the wired backhaul port: it is removed from the LAN bridge and dedicated to mesh backhaul.
- Port names may differ between devices (for example `lan3` on one side and `lan4` on the other); what matters is that the cable connects each device's selected port.

### 5.2 Steps

1. On device A, select the LAN port cabled to device B (for example `lan3`) under **Wired Backhaul Port**.
2. On device B, select the LAN port cabled to device A (for example `lan4`).
3. Connect the two ports with an Ethernet cable.
4. Save and apply, then click **Reapply meshassistant Settings** on both devices.

The script removes the port from `br-lan`, creates `network.mesh_wired` (`batadv_hardif`, `master=bat0`, MTU 1500), and sets a very high throughput override so BATMAN_V prefers the wired path while the cable is up.

### 5.3 Automatic switching

The wired and wireless hardifs remain configured together:

- Cable connected: BATMAN_V prefers the wired backhaul;
- Cable unplugged: the wired hardif goes down and traffic automatically moves to the mesh radio;
- Cable restored: traffic automatically returns to wired.

BATMAN_V link detection performs the switch without manual action. This requires **both ends to have selected their port in advance**. The script does not detect an arbitrary LAN cable plugged into an unselected port.

### 5.4 Notes

- If only one end selects a wired backhaul port while the other still uses that port as an ordinary LAN port, no mesh wired backhaul is formed, and the device that selected the port loses its ordinary LAN function on that port.
- A dedicated wired backhaul port no longer carries ordinary LAN traffic. If you only need a normal wired uplink, keep **Wired Backhaul Port** at **None** and use the port as a normal LAN port.
- If the other end of the cable is a main router, a switch, or any device not running this plugin, do not select a wired backhaul port; that is an ordinary LAN connection.
- The script does not handle `bridge-vlan` (VLAN filtering) configurations. On VLAN-filtered devices, verify port membership manually before enabling wired backhaul.
- When you change the port or disable the mesh, the script returns the old port to the LAN bridge.

## 6. Dumb AP mode

**Enable Dumb AP Mode** attaches a node to an existing network whose DHCP server is another router, so it acts only as a wireless access point.

Before using it, confirm:

- You accept that the management address changes, and you know the new address;
- You can reach the device again over a cable or at the new address;
- The network already has a DHCP server (normally the main router).

Clicking the button opens a confirmation dialog; the mode is only applied after you confirm again. The script then:

- backs up `wireless`, `network`, `dhcp`, `system` and `firewall` to `/etc/config/*.meshbak`;
- disables `firewall`, `dnsmasq` and `odhcpd`;
- sets the LAN to the static address from **AP Mode**, or to a DHCP client;
- deletes `wan` / `wan6` and adds the WAN port to `br-lan`;
- adjusts firewall zones, disables LAN DHCP and writes the hostname.

To undo it:

```sh
bash /etc/meshassistant/shell/meshassistant.sh undumb
```

The current configuration is moved to `/etc/config/*.dumbap` for reference, the `*.meshbak` files are restored, and the disabled services are re-enabled.

> Dumb AP mode is destructive: it changes the management address, removes WAN and changes the firewall. Back up first and make sure you have physical access to the device.

## 7. Verification and troubleshooting

### 7.1 Page status

After applying, refresh the page. **Mesh Status** at the top shows:

- the number of active nodes;
- neighbour nodes, interface, the IP addresses of each neighbour and its clients, and last-seen time.

While the **Mesh Status** tab is open it refreshes every 10 seconds; it pauses when the browser tab is in the background or another tab is selected, and refreshes immediately when switched back. The refresh only re-reads `batctl n`, the peer announcements and the wireless state, so it does not touch a form being edited.

If it shows **Unable to read mesh status**, `batctl` is missing or failing; this is not the same as zero neighbours.

### 7.2 Useful checks

Over SSH:

```sh
# Mesh neighbours
batctl n

# Local mesh configuration
uci show meshassistant

# BATMAN interfaces and addresses
ip -4 addr show br-lan
iw dev

# Last apply log
cat /tmp/meshassistant.log

# System log
logread | tail -50
```

### 7.3 Common problems

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| Mesh enabled on both sides but zero neighbours | Different mesh radio, mesh SSID or password; devices too far apart; radio does not support 802.11s | Compare radio, SSID and password on all devices; test with the devices close together |
| Node page unreachable | Static address outside the subnet, duplicate address, no DHCP server, or Dumb AP changed the address | Check the server's DHCP leases; review the node configuration; use a cable, serial console or recovery mode if needed |
| WiFi clients cannot get an IP | Server DHCP is off and no other DHCP server exists on the LAN | Enable server DHCP, or let the main router provide DHCP |
| Wired backhaul does not work | Only one end selected a port; the port is not a LAN bridge port; cable is loose; port is owned by WAN | Select the port on both ends; check `/tmp/meshassistant.log`; use a LAN bridge port |
| Traffic still uses wireless while the cable is connected | Cable is down or failed to negotiate; both ends are not configured; the other end is not a mesh device | Check the cable, both configurations and the log |
| Address changed after disabling the mesh | The script restored the pre-enable LAN address; this is expected | Reconnect at the original address |
| Firewall/DHCP services disappeared on a node | Nodes disable `firewall`, `dnsmasq` and `odhcpd`; this is normal | Disabling the mesh or switching back to Server restores them |
| **Mesh Status** says this node has no DHCP lease | In DHCP mode the LAN got no address after the apply: uplink cable unplugged, no DHCP server upstream, or the server's **Server Provides DHCP** is off | Check the cable and the server's DHCP leases; switch to a static IP if it cannot be recovered |

### 7.4 Reading the log

`/tmp/meshassistant.log` is appended to across runs (the oldest part is
dropped once it passes 256 KiB). It records:

- wireless interfaces created or removed;
- LAN address and hostname changes;
- wired backhaul ports removed and restored;
- DHCP option 6 written or restored by the server (**DHCP DNS Server**);
- the lease check after an apply in DHCP mode (the address, or the no-lease warning);
- port validation failures and fallback to wireless backhaul;
- backups created, restored, deleted or cleared from the **Backup Management** tab.

Start troubleshooting there, then combine it with `batctl n` and `logread`.

## 8. Mesh examples

The examples assume W1700K or similar dual-band routers, with `radio0` (5GHz/6GHz) for mesh backhaul and `radio1` for the regular AP. Use the radio names shown in the page's drop-down lists on your own devices.

### Example 1: Two routers, wireless backhaul only

Good for a first mesh, a small apartment, or a rental: one server and one node, all backhaul over WiFi.

```text
[Internet]
   │ WAN
[Router A: Server 192.168.10.1]
   │
   ~~~~ 5GHz mesh backhaul (SSID: MyMesh-mesh) ~~~~
   │
[Router B: Node 192.168.10.2]
```

**Router A (Server)**

| Field | Value |
| --- | --- |
| Enable Mesh Networking | on |
| Mesh Mode | Server |
| Server Provides DHCP | on |
| WiFi Network SSID | `HomeWiFi` |
| Regular AP Radio | `radio1` |
| Mesh Radio | `radio0` |
| Wired Backhaul Port | None |
| Mesh Network SSID | `MyMesh` |
| Password Protection | enable if wanted; same password on every device |
| LAN address | set to `192.168.10.1/24` first |

**Router B (Node)**

| Field | Value |
| --- | --- |
| Enable Mesh Networking | on |
| Mesh Mode | Node |
| WiFi Network SSID | `HomeWiFi` (may match A or differ) |
| Regular AP Radio | `radio1` |
| Mesh Radio | `radio0` |
| Wired Backhaul Port | None |
| Mesh Network SSID | `MyMesh` |
| Password Protection / Mesh Password | exactly the same as A |
| Node Hostname | `node2` |
| IP Mode | Static |
| Static IP Address | `192.168.10.2` |
| Mesh Gateway IP Address | `192.168.10.1` |
| IPv4 netmask | `255.255.255.0` |
| DNS Server | `192.168.10.1` |

**Order of operations**

1. Set A's LAN to `192.168.10.1` and connect its WAN uplink.
2. Fill in A, save, and click **Reapply meshassistant Settings**.
3. Fill in B, save, and click **Reapply meshassistant Settings**.
4. Wait for wireless to restart, then open **Mesh Status** on both devices; each should list the other as a neighbour.
5. Connect a phone to `HomeWiFi`; it should receive a `192.168.10.x` address and reach the internet.

> If B uses **IP Mode: DHCP**, it gets an address from A. Find `node2` under A's **DHCP Leases**. A static IP is still recommended when you need a stable address.

### Example 2: Three routers, one server + two nodes, mixed backhaul

Good for a duplex, two floors, or a long apartment: the server and one node use a wired backhaul, the other node is wireless, and all three form one mesh.

```text
[Internet]
   │ WAN
[Router A: Server 192.168.10.1] (living room)
   │ lan3 (dedicated wired backhaul)
   │
[Router B: Node 192.168.10.2] (study)
   │
   ~~~~ wireless mesh (may relay through B) ~~~~
   │
[Router C: Node 192.168.10.3] (bedroom)
```

**A (Server)**

- Mesh Mode: Server; Server Provides DHCP: on.
- Mesh Radio `radio0`, Mesh Network SSID `MyMesh`, password identical to B and C.
- Wired Backhaul Port: select the LAN port cabled to B (for example `lan3`).
- Regular AP Radio: `radio1`; LAN address: `192.168.10.1`.

**B (Node)**

- Mesh Mode: Node; Mesh Radio `radio0`; Mesh Network SSID `MyMesh`; same password.
- Wired Backhaul Port: select the LAN port cabled to A (for example `lan3`; the port name does not need to match A's).
- Node Hostname: `node2`; IP Mode: Static; address `192.168.10.2`; gateway `192.168.10.1`; netmask `255.255.255.0`; DNS `192.168.10.1`.
- Note: once `lan3` is dedicated to backhaul it no longer carries ordinary LAN traffic. Manage B over WiFi or another LAN port.

**C (Node)**

- Mesh Mode: Node; Mesh Radio `radio0`; Mesh Network SSID `MyMesh`; same password.
- Wired Backhaul Port: None (wireless only).
- Node Hostname: `node3`; IP Mode: Static; address `192.168.10.3`; gateway `192.168.10.1`; netmask `255.255.255.0`; DNS `192.168.10.1`.
- C can talk to A directly; if it is out of range, BATMAN automatically relays through B.

**Verification**

- Run `batctl n` on A; it should list B (wired interface) and C (wireless interface), or at least the reachable neighbours.
- Unplug the A–B cable; B should switch to wireless backhaul automatically. Plug it back in and wired should be preferred again.
- **Mesh Status** on all three devices should show active nodes, and clients should stay connected while roaming between them.

### Example 3: An existing main router already provides DHCP (DHCP reuse)

Good when a main router already handles PPPoE and DHCP, and you add 2–3 mesh devices to extend coverage. This example uses three mesh devices: A as Server, B and C as Nodes; the main router does not run this plugin. It is mode B from [section 3](#3-server-uplink-modes-and-per-role-configuration-details).

```text
[Internet]
   │
[Main router 192.168.5.1: PPPoE + DHCP + IPv6 RA]
   │ LAN
   │
[Router A: Server 192.168.5.2] (Server Provides DHCP = off)
   │
   ~~~~ wireless mesh (SSID: MyMesh-mesh) ~~~~
   │
[Router B: Node 192.168.5.3]   [Router C: Node 192.168.5.4]
```

**Main router**

- Keep its existing settings; it continues to provide DHCP and IPv6 RA.
- Do not enable a second DHCP server on the main router.

**A (Server)**

| Field | Value |
| --- | --- |
| Mesh Mode | Server |
| Server Provides DHCP | **off** |
| Mesh Radio | `radio0` |
| Mesh Network SSID | `MyMesh` |
| Password Protection / Mesh Password | same as B and C |
| Regular AP Radio | `radio1` |
| LAN address | `192.168.5.2/24`, gateway/DNS pointing to the main router `192.168.5.1` |
| Wired Backhaul Port | if A–B uses wired backhaul, select the dedicated LAN port cabled to B; the cable to the main router must use a different LAN port that stays in the bridge |

Set A's LAN address in advance under **Network → Interfaces → LAN**; the Server role does not show the AP Mode tab.

**B and C (Nodes)**

| Field | B | C |
| --- | --- | --- |
| Mesh Mode | Node | Node |
| Mesh Radio | `radio0` | `radio0` |
| Mesh Network SSID | `MyMesh` | `MyMesh` |
| Password | same as A | same as A |
| Node Hostname | `node2` | `node3` |
| IP Mode | DHCP or Static | DHCP or Static |
| Static address (if Static) | `192.168.5.3` | `192.168.5.4` |
| Gateway (if Static) | `192.168.5.1` | `192.168.5.1` |
| Netmask | `255.255.255.0` | `255.255.255.0` |
| DNS (if Static) | `192.168.5.1` | `192.168.5.1` |

**Notes**

- With `DHCP`, B and C get `192.168.5.x` addresses from the main router; with `Static`, they use the addresses above for easier management.
- If you want mesh clients to use A's DNS/filtering service (for example OpenClash / OxiDNS), set the nodes' gateway and DNS to `192.168.5.2` and make sure A forwards traffic to the main router. Otherwise leave them at `192.168.5.1`.
- The cable from A to the main router is an ordinary LAN uplink: do not select that port as **Wired Backhaul Port**; if A–B uses wired backhaul, use another pair of dedicated LAN ports.
- The dedicated cable between A and B is this plugin's wired backhaul: select the dedicated port on both ends and connect them directly, not through the main router.
- There must be only one DHCP server. A's **Server Provides DHCP** must be off, or it will conflict with the main router.

## 9. Disabling, rolling back and recovery

### 9.1 Normal shutdown

1. Turn off **Enable Mesh Networking**.
2. Click **Save & Apply**, then **Reapply meshassistant Settings**.

The script removes the mesh/AP interfaces, deletes `bat0` and `mesh_batman`, returns the wired backhaul port to `br-lan`, and restores the pre-enable LAN address, hostname, DHCP/RA settings (including DHCP option 6 written by the server) and the services it disabled.

### 9.2 Undo Dumb AP mode

```sh
bash /etc/meshassistant/shell/meshassistant.sh undumb
```

### 9.3 Emergency recovery

If a misconfiguration makes LuCI unreachable:

- If LuCI is still reachable, restore an earlier archive from **Backup Management** first; the restore restarts networking, so the connection may drop again;
- Connect a cable to a LAN port and look for the device in the server's DHCP leases;
- If you know the static address, put your computer in the same subnet and connect directly;
- Check `/tmp/meshassistant.log` and `logread` (SSH or serial console required);
- Restore the files in `/root/mesh-backup/`, or use OpenWrt failsafe mode;
- Dumb AP mode can be undone with `undumb`, which restores the five backed-up configuration files.

> Keep a backup before every change, and make sure you have physical access to the device. That is the most effective way to avoid bricking it.

## 10. Backup management

The **Backup Management** tab, immediately before **Run Log**, saves and
restores the whole network configuration. Day-to-day use needs no SSH.

### 10.1 The four actions

| Button | Behaviour |
| --- | --- |
| Create Backup | Archives the current configuration under `/etc/meshassistant/backup` immediately. |
| Restore Backup | Restores one of the listed archives; when several exist, a drop-down lets you choose. The current configuration is archived first, so an unwanted restore can itself be undone. |
| Delete Backup | Deletes one selected archive; choose first when several exist, then confirm. |
| Clear Backups | Deletes every archive; asks for confirmation. |

Creating, restoring, deleting and clearing leave a timestamped record in
`/tmp/meshassistant.log`, visible on the **Run Log** tab.

### 10.2 When backups happen automatically

- Clicking **Save & Apply** archives the current configuration **before** the save is written.
- Clicking **Reapply meshassistant Settings** makes the script create another backup before enabling or disabling the mesh.
- Every apply therefore leaves a snapshot; delete or clear old archives from the tab when they accumulate.

### 10.3 Contents and format

- Location: `/etc/meshassistant/backup/`, directory mode 0700.
- File name: `YYYYMMDD-HHMMSS.tar`; a same-second collision gets a `-1`, `-2`, … suffix. Files are mode 0600.
- Contents: `etc/config/network`, `wireless`, `dhcp`, `firewall`, `system` and `meshassistant`, plus a `manifest` with the creation time, hostname, LAN address, role, mesh switch and the enable state of `firewall`, `dnsmasq` and `odhcpd`.
- The archive contains the WiFi and mesh passwords; keep it private and do not hand it to others casually.

### 10.4 Restore workflow

1. In **Backup Management**, click **Restore Backup** and pick the target archive from the drop-down when several exist.
2. After confirmation the script first creates a safety archive of the current configuration, then validates the chosen archive: only the expected file names are allowed, symbolic links are rejected, and every configuration is syntax-checked with `uci`.
3. If validation passes, the six files are written back, the recorded enable state of `firewall`, `dnsmasq` and `odhcpd` is restored, and the mesh service is started or stopped according to the archived mesh switch.
4. Finally it runs `reload_config`, `/etc/init.d/network reload` and `wifi reload`.

The restore runs in the background and writes its output to
`/tmp/meshassistant.log`. **Networking and wireless restart during the restore,
so the current connection may drop and the management address may change.**
Prefer a wired connection, or make sure you know the LAN address stored in the
archive; if the restored address differs from the one you are using, log in
again at the new address.

### 10.5 Command-line inspection and emergency restore

Over SSH you can inspect the archives read-only:

```sh
bash /etc/meshassistant/shell/meshassistant.sh backup list
ls -l /etc/meshassistant/backup
tar -tf /etc/meshassistant/backup/20261105-143022.tar
```

If LuCI is unreachable, you can also extract an archive and copy the files
manually:

```sh
mkdir -p /tmp/restore
tar -xf /etc/meshassistant/backup/<file>.tar -C /tmp/restore
cp /tmp/restore/etc/config/network /etc/config/network
# copy wireless, dhcp, firewall, system and meshassistant as needed
```

A manual restore only writes the configuration files: it does not restore the
recorded service states and does not reload the network. After copying, run
`reload_config`, `/etc/init.d/network reload` and `wifi reload`, or simply
reboot the device.

---

Related documents:

- [Project home](../README.en.md)
- [简体中文指南](README.md)
- [Batman-adv documentation](https://www.open-mesh.org/projects/batman-adv/wiki)
