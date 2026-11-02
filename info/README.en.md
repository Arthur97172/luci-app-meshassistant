# Easy Mesh Detailed Configuration Guide

English | [简体中文](README.md)

This guide explains how to build a mesh with luci-app-meshassistant: how to choose roles and addresses, when a Node or Client needs a static IP, how wired and wireless backhaul work together, and three complete examples with 2–3 wireless routers. For installation and a feature overview, see the [project home page](../README.en.md).

> Everything here matches the fields on the page and the actual behaviour of the script. The shell commands are for checking status and emergency recovery only; use the LuCI page for day-to-day configuration.

## Contents

- [1. Before you start](#1-before-you-start)
- [2. Page fields and workflow](#2-page-fields-and-workflow)
- [3. When a Node / Client needs a static IP](#3-when-a-node--client-needs-a-static-ip)
- [4. Configuring wired backhaul](#4-configuring-wired-backhaul)
- [5. Dumb AP mode](#5-dumb-ap-mode)
- [6. Verification and troubleshooting](#6-verification-and-troubleshooting)
- [7. Mesh examples](#7-mesh-examples)
- [8. Disabling, rolling back and recovery](#8-disabling-rolling-back-and-recovery)

## 1. Before you start

### 1.1 Hardware and firmware

- Every device runs OpenWrt / ImmortalWrt 24.10 or 25.12 with JavaScript-based LuCI.
- Install `luci-app-meshassistant`, plus `kmod-batman-adv`, `batctl-default`, `luci-proto-batman-adv`, `kmod-cfg80211`, `dawn` and `bash`.
- At least one radio must support 802.11s mesh. A dual-band device is recommended: use one radio for the regular AP and the other exclusively for mesh backhaul, so regular WiFi and backhaul do not compete for airtime on the same radio.

### 1.2 Plan the topology

Decide these four things before configuring anything:

| Item | Description |
| --- | --- |
| Roles | Exactly one **Server** per mesh; every other device is a **Node**. **Client** behaves the same as Node in the current script. |
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

The plugin also backs up the LAN, hostname and DHCP settings it changes, and restores them when the mesh is disabled. The manual copy is for power loss, mistakes, or a full reinstall.

### 1.4 Management connection

Applying settings restarts networking and wireless. Therefore:

- Prefer a wired connection to a port that will **not** be removed from the LAN bridge;
- Do not manage the device over the WiFi or the port that is about to be reconfigured;
- After changing a node to a static IP, a browser connected through the old address will drop; reconnect at the new address.

## 2. Page fields and workflow

Menu entry: **Network → Easy Mesh** (Chinese: **网络 → MESH助手**).

### 2.1 Basic Setup

| Field | Purpose |
| --- | --- |
| Enable Mesh Networking | Master switch. Saving only writes the form; click **Reapply meshassistant Settings** to apply it. |
| Mesh Mode | Server / Node / Client. |
| Server Provides DHCP | Server only. When enabled, the server provides DHCP and IPv6 RA. Disable it when another router on the LAN already provides DHCP. |
| WiFi Network SSID | Name of the regular WiFi access point. |
| Regular AP Radio | Radio that carries the regular WiFi. |
| Mesh Radio | Radio that carries mesh backhaul, single-select. Every device must use the same radio. |
| Wired Backhaul Port | Optional. Select the LAN bridge port cabled to another mesh device; keep **None** for wireless-only backhaul. |
| Mesh Network SSID | Mesh backhaul identifier; must be identical on every device. The actual 802.11s `mesh_id` gets a `-mesh` suffix: entering `MyMesh` makes the over-the-air mesh ID `MyMesh-mesh`. |
| Password Protection / Mesh Password | When enabled, the regular AP uses WPA3 mixed mode and the mesh backhaul uses WPA3; the password needs at least 8 characters. Every device must match. |

> Every device must use exactly the same **Mesh Radio**, **Mesh Network SSID**, **Password Protection** setting and **Mesh Password**. Otherwise no neighbour will appear.

### 2.2 AP Mode (Node / Client only)

| Field | Purpose |
| --- | --- |
| Node Hostname | `node2` – `node9` are suggested (a custom name is also accepted); written to the system hostname so the device is easy to identify in DHCP leases and SSH. Use a different name on each node. |
| IP Mode | `DHCP`: the node's LAN is a DHCP client. `Static`: use the address fields below. A node never provides DHCP. |
| Static IP Address | Node LAN address; must be in the same subnet as the server/gateway and must be unique. |
| Mesh Gateway IP Address | Node's default gateway; normally the server's LAN address. In a DHCP-reuse topology, use the address of the actual internet router. |
| IPv4 netmask | Match the server/main router; commonly `255.255.255.0`. |
| DNS Server | Normally the server's LAN address; an upstream router or a public DNS server also works. |
| Enable Dumb AP Mode | Converts the node into a dumb AP attached to an existing network. It changes the management address and asks for confirmation first. See [section 5](#5-dumb-ap-mode). |

These settings are not limited to Dumb AP mode: a normal node enable also applies IP Mode and hostname. The previous LAN and hostname values are backed up and restored when the mesh is disabled.

### 2.3 Advanced Settings

K/V/R, Mobility Domain (four hex digits) and the RSSI thresholds tune roaming. Leave them at their defaults unless you understand 802.11k/v/r and `dawn`. All devices should use the same mobility domain.

### 2.4 Save and apply

1. Click **Save & Apply** at the bottom of the page. This only writes `/etc/config/meshassistant`; it does not touch the network.
2. Click **Reapply meshassistant Settings**. The script now creates/removes interfaces, changes the LAN, and starts or stops services. Its output goes to `/tmp/meshassistant.log`.
3. Recommended order: **server first, then nodes**. The server forms the mesh gateway; nodes can only join once it exists.
4. Networking and wireless restart during the apply, so the page may disconnect briefly. Reconnect and refresh once the restart has finished.

## 3. When a Node / Client needs a static IP

### 3.1 What "IP Mode" means on a node

Nodes and Clients do not provide DHCP and do not perform NAT. They disable `firewall`, `dnsmasq` and `odhcpd`, add only `bat0` to `br-lan`, and reach the server at layer 2 through the mesh.

**IP Mode controls where the node's own management address comes from:**

- **DHCP** (default): the script sets the node LAN to a DHCP client. The node must be able to reach a DHCP server on the mesh LAN, normally:
  - a Server role with **Server Provides DHCP** enabled; or
  - another router already on the LAN.
- **Static**: the script sets the node LAN to a static address using the address, netmask, gateway and DNS you enter.

### 3.2 When to use a static IP

| Situation | Why |
| --- | --- |
| There is no DHCP server on the mesh LAN | The server has **Server Provides DHCP** disabled and there is no other main router. A DHCP-mode node gets no address and loses its management entry point. |
| You need a stable management address | Bookmarks, SSH, monitoring, port forwarding and remote access all prefer a fixed node address. |
| You have several nodes | Assigning `.2`, `.3`, `.4` makes nodes easier to tell apart than searching a lease table. |
| The DHCP pool is small or addresses change often | Avoid losing access when a lease changes. |
| Dumb AP deployment | A dumb AP should normally have a fixed management address. |
| Troubleshooting | A static address removes DHCP as a variable when a node goes unreachable. |

### 3.3 When DHCP is fine

- The server has **Server Provides DHCP** enabled and the node can obtain an address through the mesh;
- or the LAN has a reliable main-router DHCP server;
- and you do not need a fixed address, or are willing to look the node up in the server's lease table.

In DHCP mode, find the node's address under **Status → DHCP Leases** on the server, or in `/tmp/dhcp.leases` over SSH. The node hostname (`node2`, `node3`, …) normally appears in the lease as well, which makes identification easier.

### 3.4 Static IP rules

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

### 3.5 Common static-IP mistakes

| Mistake | Consequence | Correct approach |
| --- | --- | --- |
| Address outside the server's subnet | The node is unreachable at layer 3 and the page drops | Use the same subnet as the server |
| Address already in use | Intermittent outages and ARP conflicts | Pick a free address or configure a static lease |
| Gateway set to the node itself or a wrong address | The node cannot reach the management network or the internet | Use the server or upstream router |
| Netmask differs from the server | Some devices become unreachable | Match the server |
| Leaving the default `192.168.8.x` | The node is unreachable | Change it to your real LAN |
| Static address inside the DHCP pool | DHCP may hand the same address to another device | Use an address outside the pool or a static lease |

### 3.6 The server also needs a fixed address

The Server role does not show the AP Mode tab and does not change its LAN through that tab. Before enabling the mesh, set the server LAN to a static address (for example `192.168.10.1/24`) under **Network → Interfaces → LAN**, with the correct gateway and DNS. Otherwise the server address may change with upstream DHCP and the gateway configured on the nodes will become invalid.

## 4. Configuring wired backhaul

Wired backhaul is optional, supported by all three roles, and configured per device.

### 4.1 Requirements

- Both ends of the cable must be mesh devices running this plugin, and both must select their connected port under **Wired Backhaul Port**.
- The selected port must be a **LAN bridge port**. It must not be a WAN port or a port already owned by another logical interface.
- Do not select the management port or an ordinary LAN uplink port as the wired backhaul port: it is removed from the LAN bridge and dedicated to mesh backhaul.
- Port names may differ between devices (for example `lan3` on one side and `lan4` on the other); what matters is that the cable connects each device's selected port.

### 4.2 Steps

1. On device A, select the LAN port cabled to device B (for example `lan3`) under **Wired Backhaul Port**.
2. On device B, select the LAN port cabled to device A (for example `lan4`).
3. Connect the two ports with an Ethernet cable.
4. Save and apply, then click **Reapply meshassistant Settings** on both devices.

The script removes the port from `br-lan`, creates `network.mesh_wired` (`batadv_hardif`, `master=bat0`, MTU 1500), and sets a very high throughput override so BATMAN_V prefers the wired path while the cable is up.

### 4.3 Automatic switching

The wired and wireless hardifs remain configured together:

- Cable connected: BATMAN_V prefers the wired backhaul;
- Cable unplugged: the wired hardif goes down and traffic automatically moves to the mesh radio;
- Cable restored: traffic automatically returns to wired.

BATMAN_V link detection performs the switch without manual action. This requires **both ends to have selected their port in advance**. The script does not detect an arbitrary LAN cable plugged into an unselected port.

### 4.4 Notes

- If only one end selects a wired backhaul port while the other still uses that port as an ordinary LAN port, no mesh wired backhaul is formed, and the device that selected the port loses its ordinary LAN function on that port.
- A dedicated wired backhaul port no longer carries ordinary LAN traffic. If you only need a normal wired uplink, keep **Wired Backhaul Port** at **None** and use the port as a normal LAN port.
- If the other end of the cable is a main router, a switch, or any device not running this plugin, do not select a wired backhaul port; that is an ordinary LAN connection.
- The script does not handle `bridge-vlan` (VLAN filtering) configurations. On VLAN-filtered devices, verify port membership manually before enabling wired backhaul.
- When you change the port or disable the mesh, the script returns the old port to the LAN bridge.

## 5. Dumb AP mode

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
bash /meshassistant/meshassistant.sh undumb
```

The current configuration is moved to `/etc/config/*.dumbap` for reference, the `*.meshbak` files are restored, and the disabled services are re-enabled.

> Dumb AP mode is destructive: it changes the management address, removes WAN and changes the firewall. Back up first and make sure you have physical access to the device.

## 6. Verification and troubleshooting

### 6.1 Page status

After applying, refresh the page. **Mesh Status** at the top shows:

- the number of active nodes;
- neighbour nodes, interface and last-seen time.

If it shows **Unable to read mesh status**, `batctl` is missing or failing; this is not the same as zero neighbours.

### 6.2 Useful checks

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

### 6.3 Common problems

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| Mesh enabled on both sides but zero neighbours | Different mesh radio, mesh SSID or password; devices too far apart; radio does not support 802.11s | Compare radio, SSID and password on all devices; test with the devices close together |
| Node page unreachable | Static address outside the subnet, duplicate address, no DHCP server, or Dumb AP changed the address | Check the server's DHCP leases; review the node configuration; use a cable, serial console or recovery mode if needed |
| WiFi clients cannot get an IP | Server DHCP is off and no other DHCP server exists on the LAN | Enable server DHCP, or let the main router provide DHCP |
| Wired backhaul does not work | Only one end selected a port; the port is not a LAN bridge port; cable is loose; port is owned by WAN | Select the port on both ends; check `/tmp/meshassistant.log`; use a LAN bridge port |
| Traffic still uses wireless while the cable is connected | Cable is down or failed to negotiate; both ends are not configured; the other end is not a mesh device | Check the cable, both configurations and the log |
| Address changed after disabling the mesh | The script restored the pre-enable LAN address; this is expected | Reconnect at the original address |
| Firewall/DHCP services disappeared on a node | Nodes disable `firewall`, `dnsmasq` and `odhcpd`; this is normal | Disabling the mesh or switching back to Server restores them |

### 6.4 Reading the log

`/tmp/meshassistant.log` records:

- wireless interfaces created or removed;
- LAN address and hostname changes;
- wired backhaul ports removed and restored;
- port validation failures and fallback to wireless backhaul.

Start troubleshooting there, then combine it with `batctl n` and `logread`.

## 7. Mesh examples

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

Good when a main router already handles PPPoE and DHCP, and you add 2–3 mesh devices to extend coverage. This example uses three mesh devices: A as Server, B and C as Nodes; the main router does not run this plugin.

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

## 8. Disabling, rolling back and recovery

### 8.1 Normal shutdown

1. Turn off **Enable Mesh Networking**.
2. Click **Save & Apply**, then **Reapply meshassistant Settings**.

The script removes the mesh/AP interfaces, deletes `bat0` and `mesh_batman`, returns the wired backhaul port to `br-lan`, and restores the pre-enable LAN address, hostname, DHCP/RA settings and the services it disabled.

### 8.2 Undo Dumb AP mode

```sh
bash /meshassistant/meshassistant.sh undumb
```

### 8.3 Emergency recovery

If a misconfiguration makes LuCI unreachable:

- Connect a cable to a LAN port and look for the device in the server's DHCP leases;
- If you know the static address, put your computer in the same subnet and connect directly;
- Check `/tmp/meshassistant.log` and `logread` (SSH or serial console required);
- Restore the files in `/root/mesh-backup/`, or use OpenWrt failsafe mode;
- Dumb AP mode can be undone with `undumb`, which restores the five backed-up configuration files.

> Keep a backup before every change, and make sure you have physical access to the device. That is the most effective way to avoid bricking it.

---

Related documents:

- [Project home](../README.en.md)
- [简体中文指南](README.md)
- [Batman-adv documentation](https://www.open-mesh.org/projects/batman-adv/wiki)
