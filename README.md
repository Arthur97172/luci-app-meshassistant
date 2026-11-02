# MESH助手（luci-app-meshassistant）

简体中文 | [English](README.en.md)

一个面向 OpenWrt / ImmortalWrt 的 Batman-adv Mesh 配置页面。在 LuCI 中选好角色、填写 SSID 与密码，点一下按钮即可把本机配置为 Mesh 服务器、节点或客户端；页面同时显示当前邻居节点状态。界面完全使用 JavaScript 实现，不依赖 `luci-compat`、`luci-lua-runtime` 或 `libiwinfo-lua`。

插件位于 **网络 → MESH助手**（`admin/network/meshassistant`；英文界面为 **Network → Easy Mesh**），页面标题为「MESH助手 WiFi 设置」。

## 功能

| 功能 | 说明 |
| --- | --- |
| 三种角色 | 服务器（Server，作为网关）、节点（Node）、客户端（Client） |
| 普通 AP + Mesh 回程 | 普通 WiFi 与 Mesh 回程可以分别选择射频；Mesh 射频为单选 |
| Mesh 状态 | 读取 `batctl n`，显示活动节点数、接口、邻居节点和最后发现时间 |
| 后台应用 | 应用设置时脚本脱离页面在后台执行，避免 WiFi / 网络重启导致请求超时或页面掉线 |
| Dumb AP 模式 | 把节点切换为接入现有网络的哑 AP（会更换管理地址） |
| DHCP 可复用 | 服务器可选择是否提供 DHCP/IPv6 RA；LAN 上已有 DHCP 服务器时可关闭 |
| 国际化 | 支持英文与简体中文；中文以独立语言包提供 |
| 亮色 / 暗色 | 自动跟随 LuCI 主题，无需手动切换 |

## 安装

### 从 Releases 安装

1. 打开 [Releases](https://github.com/Arthur97172/luci-app-meshassistant/releases) 页面，下载安装包。
2. 把安装包上传到设备（例如 `/tmp`），然后安装：

   **OpenWrt 24.10 及更早（opkg）**

   ```sh
   opkg install /tmp/luci-app-meshassistant_*.ipk

   #可选，安装简体中文语言包：

   opkg install /tmp/luci-i18n-meshassistant-zh-cn_*.ipk
   ```

   **OpenWrt 25.12+（apk）**

   ```sh
   apk add --allow-untrusted /tmp/luci-app-meshassistant-*.apk

   #可选，安装简体中文语言包：

   apk add --allow-untrusted /tmp/luci-i18n-meshassistant-zh-cn-*.apk
   ```

3. 刷新 LuCI，入口出现在「网络 → MESH助手」。

> 未安装语言包时界面显示英文（菜单为「Easy Mesh」）。安装包架构无关（ipk 记为 `all`，apk 记为 `noarch`），ARM / x86 / MIPS 等平台通用；`batctl`、`kmod-batman-adv` 等依赖由软件源提供。

### 从源码编译

```sh
cd openwrt
./scripts/feeds update -a
./scripts/feeds install -a
git clone https://github.com/Arthur97172/luci-app-meshassistant.git package/luci-app-meshassistant
make menuconfig     # LuCI → Applications → luci-app-meshassistant
make package/luci-app-meshassistant/compile V=s
```

编译产物位于 `bin/packages/<架构>/base/` 目录下，主包和 `luci-i18n-meshassistant-zh-cn` 会一并生成。

## 使用方法

1. 打开「网络 → MESH助手」。页面顶部是「Mesh 状态」，下方是「Mesh 设置」表单，分为「基础设置」「AP 模式」「高级设置」三个标签页。
2. 在「基础设置」里填写：
   - **启用 Mesh 网络**：总开关，默认关闭。
   - **Mesh 模式**：服务器 / 节点 / 客户端；三者的具体行为和配置差异见下方「Mesh 模式说明」。
   - **服务器提供 DHCP**：仅在「服务器」模式显示。保持开启时，服务器负责 LAN 的 DHCP 与 IPv6 RA；如果 LAN 上已有其他路由器（例如主路由 `192.168.5.1`）提供 DHCP，请关闭此项。服务器仍保留网关和 DNS 角色，但会停止自身的 DHCP/RA 服务。
   - **WiFi 网络 SSID**：普通 WiFi 接入点的名称。
   - **普通 AP 射频**：承载普通 WiFi 的射频。
   - **Mesh 射频**：承载 Mesh 回程的射频；当前脚本只支持一个（界面为单选，旧配置中的多值会被脚本拒绝）。
   - **Mesh 网络 SSID**：同一 Mesh 中所有设备必须一致。
   - **密码保护 / Mesh 密码**：开启后，普通 AP 使用 WPA3 混合模式（`sae-mixed`），Mesh 回程使用 WPA3（`sae`）；密码至少 8 位。
3. 选择「节点」或「客户端」后，「AP 模式」标签页才会出现：
   - **节点主机名**：`node2` – `node9`。
   - **IP 模式 / 静态 IP 地址 / Mesh 网关 IP 地址 / IPv4 子网掩码 / DNS 服务器**：选择静态 IP 时填写。
   - **启用哑 AP 模式**：见下方警告。
4. 「高级设置」包含 K/V/R 开关、移动域（4 位十六进制）、良好 / 较差 RSSI 阈值。除非了解相关设置，否则保持默认值。
5. 点击页面底部的「保存并应用」。这一步只把表单写入 `/etc/config/meshassistant`，**还不会**改动系统网络。
6. 点击「重新应用 MESH助手设置」，脚本才会在当前配置下真正创建或删除 Mesh 网络。按钮按已保存的配置工作，所以请先保存；执行结果写入 `/tmp/meshassistant.log`。开关为关闭状态时，该按钮会清理已创建的 Mesh 接口、删除 Batman 网络、恢复启用前的 LAN/主机名/服务设置并重新加载网络。
7. 应用完成后刷新页面，顶部的「Mesh 状态」会显示活动节点数、接口、邻居节点和最后发现时间。读不到 `batctl` 输出时显示「无法读取 Mesh 状态」。

> 修改 Mesh SSID 或射频后再次应用，脚本会按当前和上一次记录的 Mesh SSID 尝试清理旧接口。

### Mesh 模式说明（服务器 / 节点 / 客户端）

「Mesh 模式」的三个选项对应脚本中的不同角色。两台或更多设备组网时，通常只选一台作为「服务器」，其余选「节点」。

| 项目 | 服务器 | 节点 | 客户端 |
| --- | --- | --- | --- |
| 脚本内部值 | `server` | `off` | `client` |
| `bat0` 网关模式 | `server` | `off` | `off` |
| 防火墙 / DHCP / DNS | 保留；DHCP/RA 可关闭 | 停用 | 停用 |
| `bat0` 加入 `br-lan` | 是 | 是 | 是 |
| `wan` 端口加入 `br-lan` | 否 | 否（哑 AP 模式除外） | 否（哑 AP 模式除外） |
| 「AP 模式」标签页 | 不显示 | 显示 | 显示 |
| 互联网上行 | 需要（若要上网） | 不需要 | 不需要 |
| 地址分配 | 本机 DHCP 服务器，或由 LAN 上其他路由器分配 | 「AP 模式」页的 DHCP 客户端或静态地址 | 同节点 |
| 典型用途 | 唯一网关 / 主设备 | 扩展 Mesh 覆盖 | 加入 Mesh 的非网关设备 |

**服务器（Server）**

- 作为 Mesh 的网关：脚本把 `bat0` 设为 `gw_mode=server`，加入 LAN 桥，并把 `bat0` 加入名称为 `lan` 的防火墙区域；`mesh_batman` 是二层接口，没有 IP 地址，脚本会把它从所有防火墙区域中移除。
- 防火墙按**区域名称**（`lan` / `wan`）查找，不再假设 `@zone[0]`、`@zone[1]` 的顺序。WAN 区域原有的网络列表（`wan`、`wan6`、`wwan` 或自定义上行）都会保留：只有区域为空时才补入 `wan`，并确保 WAN 区域启用 NAT、存在 `lan → wan` 转发规则。
- 重复应用会保留 `mesh_batman.master='bat0'`，并修正缺少 `master` 的旧 `mesh_batman` 配置。
- 默认保留 `dnsmasq`、`firewall`、`odhcpd`，由服务器给整个 Mesh 提供 DHCP、DNS 和 NAT。若关闭「服务器提供 DHCP」，脚本会设置 `dhcp.lan.ignore=1`、关闭 LAN 的 IPv6 RA/DHCPv6 并停用 `odhcpd`，但保留 `dnsmasq` 继续提供 DNS。
- 如果需要整个 Mesh 能上网，服务器必须有一台上行设备；典型是有线 WAN。上行使用 `wwan`（例如 WiFi STA）也可以，脚本不会再改写 WAN 区域的网络列表。
- 一个 Mesh 中只应有一台服务器。
- 「AP 模式」标签页不会出现；如果还需要普通 WiFi，在「基础设置」里选择「普通 AP 射频」。
- 如果完全不需要普通 AP：当前页面没有「无」选项，脚本只在 `wifi_radio` 为空时跳过 AP。可在 SSH 中执行 `uci set meshassistant.config.wifi_radio='' && uci commit meshassistant`，再运行 `/meshassistant/meshassistant.sh --detach`；之后不要在页面上再次「保存并应用」，否则会写回默认射频。已有的 `wifi_ap_*` 需要手动删除。

**节点（Node）**

- 作为 Mesh 的扩展点：脚本把 `bat0` 设为 `gw_mode=off`，只把 `bat0` 加入 LAN 桥；**不会删除防火墙区域**，也**不会把 `wan` 端口加入 `br-lan`**（避免把上行口环回进 LAN）。
- 节点会把原本处于启用状态的 `firewall`、`dnsmasq`、`odhcpd` 停用，并把“哪些服务是我停用的”记录到 `meshassistant` 配置中。关闭 Mesh 或把角色切回服务器时会自动恢复这些服务，不会留下永久停用的防火墙/DHCP。
- 「AP 模式」页的设置现在会在**普通启用**时生效：脚本按「IP 模式」把 LAN 设为 DHCP 客户端，或写入「静态 IP 地址 / 网关 / 子网掩码 / DNS」，并写入「节点主机名」。启用前的 LAN 与主机名会先备份，关闭 Mesh 时自动恢复。
- 节点不提供 DHCP/NAT，客户端由服务器（或 LAN 上已有的 DHCP 服务器）分配地址；选择静态 IP 时，节点地址应与服务器同网段且不冲突（例如服务器 `192.168.10.1`，节点 `192.168.10.2`）。
- 节点不需要也不应保留 WAN 上行。有线回程请使用节点的 **LAN 口**连接上级设备；不要把节点的 WAN 口当作回程口。如果原来用 WiFi STA（`wwan`）上网，作为节点时应删除或禁用该 STA 接口，避免节点保留自己的默认路由。
- 一台 Mesh 可以有多台节点；所有节点的「Mesh 网络 SSID」和密码必须与服务器一致。

**客户端（Client）**

- 当前脚本中，`client` 与 `off`（节点）走完全相同的代码路径：`bat0` 为 `gw_mode=off`，DHCP/DNS 服务停用（并记录以便恢复），只把 `bat0` 加入 `br-lan`。
- 因此它和「节点」的实际配置效果一致，区别只在界面语义；只是扩展 Mesh 时选「节点」即可，只有在需要沿用原插件「客户端」语义时才选「客户端」。
- 「AP 模式」标签页、IP 模式/静态地址/主机名设置和哑 AP 按钮同样会出现，使用注意事项与节点相同。

**两台设备的最简示例**

- 服务器：Mesh 模式选「服务器」，LAN 保持 `192.168.10.1`，接好互联网上行；选择一个 Mesh 射频（例如 `radio0`），填写 Mesh 网络 SSID 和密码。如果 LAN 上已有其他 DHCP 服务器，关闭「服务器提供 DHCP」。
- 节点：Mesh 模式选「节点」；在「AP 模式」页把「IP 模式」设为「静态」，地址 `192.168.10.2`，网关和 DNS 指向 `192.168.10.1`，主机名可选 `node2`；删除或禁用原来的 `wwan` STA。Mesh 射频、Mesh 网络 SSID、密码与服务器完全一致。
- 先保存并应用服务器，再保存并应用节点；两边用 `batctl n` 或页面顶部的「Mesh 状态」确认邻居出现。

**DHCP 复用拓扑示例**

主路由 `192.168.5.1` 负责宽带拨号和 DHCP，另外三台 W1700K（`192.168.5.2`、`.3`、`.4`）组 Mesh：

- 三台都使用同一个「Mesh 网络 SSID」和密码；建议用 5GHz 或 6GHz 射频做 Mesh 回程，另一个射频做普通 AP。
- `192.168.5.2`（安装了 OpenClash / OxiDNS）：Mesh 模式选「服务器」，**关闭「服务器提供 DHCP」**。它保留网关、防火墙和 DNS 角色，但不与 `192.168.5.1` 争夺 DHCP；LAN 地址保持 `192.168.5.2`。
- `192.168.5.3`、`192.168.5.4`：Mesh 模式选「节点」；「AP 模式」页把「IP 模式」设为「DHCP」，或设为「静态」并各自填写不冲突的地址。节点会从 `192.168.5.1` 获取地址。
- 有线回程时，网线接节点的 **LAN 口**；`192.168.5.3` 可以接在 `192.168.5.2` 的 LAN 口下，也可以直接接在 `192.168.5.1` 下。无线回程则不需要网线。

> 三者的共同要求：同一 Mesh 内「Mesh 网络 SSID」和密码必须一致；「Mesh 射频」只支持一个（界面为单选，旧配置中的多值会被脚本拒绝）；修改射频或 SSID 后建议检查并清理旧的 `wifi_ap_*` / `mesh_*` 配置。

### 哑 AP 模式的注意事项

「启用哑 AP 模式」会备份 `wireless`、`network`、`dhcp`、`system`、`firewall` 五份配置到 `/etc/config/*.meshbak`，然后：

- 停用并禁用 `firewall`、`dnsmasq`、`odhcpd`；
- 把 LAN 改成静态地址（使用「AP 模式」里填写的值）或 DHCP 客户端；
- 删除 `wan` / `wan6`，把 `wan` 端口并入 `br-lan`；
- 修改防火墙区域、关闭 LAN DHCP，并把主机名写入 `system`。

因此点击后**管理地址可能变化，当前页面会失去连接**，这是页面上警告文字的含义。该按钮只对「节点」和「客户端」显示。

恢复方法：通过 SSH 登录设备后执行

```sh
bash /meshassistant/meshassistant.sh undumb
```

脚本会把当前配置移到 `/etc/config/*.dumbap` 留作参考，恢复之前的 `*.meshbak`，并重新启用相关服务。

## 工作原理

前端负责读取 UCI 与 `batctl n` 状态、把表单写入 `/etc/config/meshassistant`，以及通过 RPC 执行 `/meshassistant/meshassistant.sh`。浏览器本身不拼接 shell 命令，能执行什么由 rpcd ACL 精确限定（见「安全说明」）。

`/meshassistant/meshassistant.sh` 是真正的配置脚本，以 root 身份运行：

- 页面调用时总是带 `--detach`：脚本立即把自己重新放到后台执行，输出重定向到 `/tmp/meshassistant.log`，从而在 WiFi / 网络重启前就返回，避免 RPC 超时。
- **启用**（`enabled=1`）时：先尝试清理当前与上一次记录的 Mesh SSID 对应的旧接口，创建 `network.bat0`（`batadv`，BATMAN_V）和 `network.mesh_batman`（`batadv_hardif`），然后配置选中的 Mesh 射频：
  - 普通 AP：创建 `wireless.wifi_ap_<radio>`，模式 `ap`，SSID 取「WiFi 网络 SSID」，接入 `lan`，启用 802.11r 并写入移动域；
  - Mesh 回程：创建 `wireless.mesh_<radio>`，模式 `mesh`（802.11s），实际 `mesh_id` 为「Mesh 网络 SSID」加上 `-mesh` 后缀，接入 `mesh_batman`；
  - 每个接口写入后执行 `wifi reload`，最后重启网络与无线。
- **服务器**角色：`bat0` 设为 `gw_mode=server`，加入 LAN 桥；按名称找到 `lan` / `wan` 防火墙区域，把 `bat0` 加入 `lan`、把 `mesh_batman` 从所有区域移除；保留 WAN 区域已有的 `wan` / `wan6` / `wwan` / 自定义上行，并确保 NAT 与 `lan → wan` 转发存在。「服务器提供 DHCP」关闭时，设置 `dhcp.lan.ignore=1`、关闭 RA/DHCPv6 并停用 `odhcpd`，但保留 `dnsmasq` 提供 DNS。
- **节点 / 客户端**角色：`bat0` 设为 `gw_mode=off`，只把 `bat0` 加入 LAN 桥，不把 `wan` 端口加入桥；不删除任何防火墙区域；停用 `firewall`、`dnsmasq`、`odhcpd` 前先把“由本脚本停用”记录下来。两种角色走同一条处理路径。普通启用还会应用「AP 模式」页的 IP 模式/静态地址/网关/子网掩码/DNS 与主机名。
- **关闭**（`enabled=0`）时：按当前和上一次的 Mesh SSID 删除 Mesh / AP 接口，删除 `bat0` 与 `mesh_batman`，把 `bat0` 移出 LAN 桥，恢复启用前的 LAN 地址、主机名、LAN DHCP/RA 设置，并重新启用由脚本停用的服务。防火墙区域本身始终保留，只移除脚本添加的成员/转发规则。

本包没有 init 脚本。安装时只会运行 uci-defaults 创建默认配置（`enabled=0`），不会套用 Mesh 设置；升级和重启也不会自动改动网络，只有页面上的按钮会调用配置脚本。

## Mesh 状态

状态区域通过 RPC 读取 `/usr/sbin/batctl n` 的输出。解析器同时兼容两种格式：

- BATMAN_V：`邻居 最后发现时间 (速率) [接口]`
- BATMAN_IV：`接口 邻居 最后发现时间`

表头行不会匹配数据格式。`batctl` 不存在、命令执行失败或返回非零时，页面显示「无法读取 Mesh 状态」，而不是把错误当成 0 个节点。

## 主题与兼容性

- 支持 LuCI 亮色 / 暗色主题，无需手动切换：页面不包含自定义 CSS、内联颜色或颜色检测，只使用 LuCI 既有的 `cbi-*`、`.table`、`.alert-message` 等结构，由主题自身的 CSS 变量决定明暗。
- 已适配 `luci-theme-bootstrap`（OpenWrt 24.10 / 25.12 默认主题）与 `luci-theme-argon` 2.x / 3.x；菜单标题由主题的菜单脚本统一翻译。
- 兼容 OpenWrt / ImmortalWrt 24.10 与 25.12 的 JavaScript 版 LuCI，无需 `luci-compat`。
- 语言：英文为默认；安装 `luci-i18n-meshassistant-zh-cn` 后，菜单显示「MESH助手」，页面文字切换为简体中文。

## 安全说明

- rpcd ACL 精确到命令行：只允许执行 `/usr/sbin/batctl n`，以及 `/meshassistant/meshassistant.sh --detach` 和 `/meshassistant/meshassistant.sh --detach dumbap` 两种脚本调用，不接受任意参数。
- UCI 权限：可读 `meshassistant`、`wireless`，只可写 `meshassistant`；脚本对 `network`、`firewall`、`dhcp`、`system` 的修改在 root 脚本内部完成，不经过浏览器。
- 默认配置为 `enabled=0`，安装和开机都不会改动网络。
- 普通启用/关闭会修改 `network`、`firewall`、`dhcp`、`system`。脚本在第一次修改节点 LAN/主机名时把原值写入 `meshassistant` 配置的备份键，并记录由它停用的服务；关闭 Mesh 时自动恢复并删除这些备份键。
- 哑 AP 模式属于破坏性操作：会更换管理地址、删除 WAN 并停用防火墙与 DHCP 服务；脚本在操作前备份五份配置，必要时可用 `undumb` 恢复。
- 脚本日志位于 `/tmp/meshassistant.log`，可能包含 SSID、主机名和网络配置，请按需清理。
- 除 LuCI 管理界面外，本插件不额外开放端口或服务。

## 本地测试与设计文档

测试脚本与设计文档仅用于本地开发验证，保存在 `tests/` 和 `docs/` 目录中，**不包含在发布仓库中**。发布仓库保留运行时代码、翻译、构建配置、CI 工作流以及必要的说明和许可证文件。

CI（`.github/workflows/build.yml`）使用 24.10（ipk）和 25.12（apk）两套 SDK 编译，强制要求主包与中文语言包同时产出，并校验包元数据中的项目 URL 与维护者。

## 文件结构

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

> `tests/` 与 `docs/` 仅存在于本地开发环境，已加入 `.gitignore`，不随仓库发布。

## 依赖

- OpenWrt / ImmortalWrt 24.10 或 25.12，带 JavaScript 版 LuCI（`luci-base`）
- `kmod-batman-adv`、`batctl-default`、`luci-proto-batman-adv`：Batman-adv 内核模块、命令行工具与协议支持
- `kmod-cfg80211`：无线配置支持
- `dawn`：802.11k/v/r 漫游守护进程
- `bash`：配置脚本使用 bash
- 至少一个支持 802.11s Mesh 的无线射频；推荐双频设备，用其中一个射频做普通 AP、另一个做 Mesh 回程

## 许可证

GPL-3.0-only

## 致谢

- 本仓库灵感来源于 https://github.com/torguardvpn/luci-app-easymesh 并在此基础上进行了优化。
