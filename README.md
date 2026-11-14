# MESH助手（luci-app-meshassistant）

简体中文 | [English](README.en.md)

一个面向 OpenWrt / ImmortalWrt 的 Batman-adv Mesh 配置页面。在 LuCI 中选好角色、填写 SSID 与密码，点一下按钮即可把本机配置为 Mesh 服务器、节点或客户端；页面同时显示当前邻居节点状态。界面完全使用 JavaScript 实现，不依赖 `luci-compat`、`luci-lua-runtime` 或 `libiwinfo-lua`。

插件位于 **网络 → MESH助手**（`admin/network/meshassistant`；英文界面为 **Network → Mesh Assistant**），页面标题为「MESH助手 WiFi 设置」。

> **详细配置指南**：角色差异、节点/客户端何时需要静态 IP、DHCP 复用、有线回程、哑 AP、排错方法，以及 2–3 台无线路由器组网的完整示例，见
> [info/README.md](info/README.md)（简体中文） / [info/README.en.md](info/README.en.md)（English）。

## 功能

| 功能 | 说明 |
| --- | --- |
| 三种角色 | 服务器（Server，作为网关）、节点（Node）、客户端（Client） |
| 普通 AP + Mesh 回程 | 普通 WiFi 可从 2.4 GHz、5 GHz、6 GHz 中选择最多两个射频（共用同一 SSID），Mesh 回程单独选择射频；Mesh 射频为单选 |
| MLO 多链路 | 普通 AP 选择两个射频时可启用 MLO，把两个射频合并为一个 Wi-Fi 7 多链路接入点；所选射频会自动切换为 EHT 模式 |
| 有线回程 | 可选择专用一个 LAN 口作为 Mesh 有线回程：插网线时使用有线，拔掉后自动改用 Mesh 无线 |
| Mesh 状态 | 读取 `batctl n`、`iw` 及节点间的主机公告，显示活动节点数、远程主机与本机信息，包括接口、节点 MAC、路由器自身的 LAN 地址、信号强度、负载、信道占用率、链路速率和最后发现时间；状态页打开时每 10 秒自动刷新（页面在后台或切到其他标签页时暂停，切回时立即刷新）；同时检测 wpad 能力，在支持 802.11k/v 但未开启客户端漫游时提示可以开启 |
| 后台应用 | 应用设置时脚本脱离页面在后台执行，并只做非破坏性的网络 / 无线重载，避免请求超时或页面掉线 |
| 备份管理 | 「备份管理」标签页可创建、恢复、删除或清空整机配置快照；点击「保存并应用」时会先自动备份保存前的配置，归档存放于 `/etc/meshassistant/backup` |
| Dumb AP 模式 | 把节点切换为接入现有网络的哑 AP（会更换管理地址，操作前有确认对话框） |
| DHCP 可复用 | 服务器可选择是否提供 DHCP/IPv6 RA；LAN 上已有 DHCP 服务器时可关闭 |
| DHCP DNS（选项 6） | 服务器可在「基础设置」中指定 DHCP 客户端收到的 DNS 服务器，写入 LAN 的 DHCP 选项 6；留空则仍由 dnsmasq 通告本机地址。应用前原有的选项 6 会被记录，关闭 Mesh 时还原 |
| 租约检查 | 节点 / 客户端以 DHCP 方式加入时，应用后会在后台复查 LAN 是否取得租约：取得时记录地址，未取得时写入运行日志，并在「Mesh 状态」页提示检查上联网线或服务器的 DHCP 服务 |
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

> 未安装语言包时界面显示英文（菜单为「Mesh Assistant」）。安装包架构无关（ipk 记为 `all`，apk 记为 `noarch`），ARM / x86 / MIPS 等平台通用；`batctl`、`kmod-batman-adv` 等依赖由软件源提供。

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

## 快速开始

1. 打开「网络 → MESH助手」，确定这台设备是「服务器」还是「节点」。一个 Mesh 中只应有一台服务器。
2. 在「基础设置」中选择 Mesh 模式，填写 WiFi 网络 SSID、普通 AP 射频、Mesh 射频、Mesh 网络 SSID 和密码，并在「加密类型」中选择普通 WiFi 的加密方式（默认 WPA2-PSK/WPA3-SAE 混合模式，也可选 WPA2-PSK/WPA3-SAE 兼容模式、WPA2-PSK、WPA3-SAE 或 WPA2-EAP；下拉菜单只列出当前固件的 hostapd/wpad 支持的模式，手工写入不支持的配置时脚本也会自动降级并在运行日志中说明）；Mesh 回程始终使用 WPA3-SAE。普通 AP 射频可从 2.4 GHz、5 GHz、6 GHz 中选择最多两个射频，所选射频使用同一个 WiFi 网络 SSID；选择两个射频时可勾选「启用 MLO」，把两个射频合并为一个 Wi-Fi 7 多链路接入点（射频会自动切换为 EHT 模式）；6 GHz 按 WPA3 启动（所选加密方式在 6 GHz 射频上映射为对应的 WPA3 模式）；所有设备的 Mesh 射频、Mesh 网络 SSID、加密类型与密码必须一致。服务器还可在「基础设置」的「DHCP 下发的 DNS 服务器」中指定 DHCP 选项 6 下发给客户端的 DNS；留空则仍通告服务器自身。
3. 节点或客户端在「AP 模式」页设置主机名和 IP：LAN 上有 DHCP 服务器时可选 DHCP，没有 DHCP 或需要固定管理地址时选择静态 IP。**每台设备的主机名必须唯一**，Mesh 状态页用它识别设备。DNS 服务器在两种模式下都可填写：DHCP 下留空则使用下发的 DNS，填写后完全覆盖；静态下留空则保留 LAN 现有 DNS。
4. 需要有线回程时，在网线两端设备的「有线回程端口」中选择相连的 LAN 网桥端口；纯无线回程保持「无」。
5. 点击「保存并应用」，再点击「重新应用 MESH助手设置」。保存时会自动把保存前的配置备份到「备份管理」；建议先配置服务器，再配置节点；执行日志位于 `/tmp/meshassistant.log`。
6. 刷新页面，在顶部「Mesh 状态」确认邻居节点出现。

详细的字段说明、地址规划、静态 IP 规则和排错方法见 [info/README.md](info/README.md)。

## Mesh 模式速览

| 项目 | 服务器 | 节点 | 客户端 |
| --- | --- | --- | --- |
| 脚本内部值 | `server` | `off` | `client` |
| `bat0` 网关模式 | `server` | `off` | `off` |
| 防火墙 / DHCP / DNS | 保留；DHCP/RA 可关闭 | 停用（记录后可在关闭时恢复） | 停用（同节点） |
| `bat0` 加入 `br-lan` | 是 | 是 | 是 |
| `wan` 端口加入 `br-lan` | 否 | 否（哑 AP 模式除外） | 否（哑 AP 模式除外） |
| 「AP 模式」标签页 | 不显示 | 显示 | 显示 |
| 互联网上行 | 需要（WAN 口或 LAN 口接上游） | 不需要 | 不需要 |
| 典型用途 | 唯一网关 / 主设备 | 扩展 Mesh 覆盖 | 加入 Mesh 的非网关设备 |

「客户端」与「节点」在当前脚本中走相同的代码路径，实际配置效果一致，区别只在界面语义。正常情况下扩展 Mesh 时选择「节点」即可。

## 服务器上行方式

Mesh 在二层把服务器、节点和客户端连成同一个网段：三者的 `br-lan` 都包含本机 LAN 口、普通 AP 和 `bat0`，有线回程口和无线回程口都挂在 `bat0` 上。因此，服务器无论用 WAN 口还是 LAN 口连接上游，**服务器、节点和客户端（无论有线回程还是无线回程）的 LAN 口都能上网**。

- **方式 A：WAN 口接上游（路由模式）**。上游路由器或光猫接到服务器的 WAN 口。服务器保留防火墙和 NAT，LAN 设为独立静态网段（例如 `192.168.10.1/24`），开启「服务器提供 DHCP」；节点/客户端用 DHCP 或静态地址加入该网段，网关和 DNS 指向服务器。终端在任何一台设备的 LAN 口或普通 WiFi 上取得 `192.168.10.x` 地址，二层经 `bat0` 到达服务器，由服务器 NAT 后上网。
- **方式 B：LAN 口接上游（DHCP 复用）**。主路由的 LAN 接到服务器的一个 LAN 口（该端口保留在 `br-lan` 中）。服务器 LAN 设为上游同网段地址（静态 `192.168.5.2/24` 或 DHCP 客户端，网关/DNS 指向主路由），关闭「服务器提供 DHCP」；节点/客户端用 DHCP 或静态地址加入主路由网段。整个 Mesh 是主路由的二层延伸，终端由主路由分配地址并直接经主路由上网，服务器不做 NAT。
- 两种方式都只能有一个 DHCP 服务器；节点/客户端的 WAN 口不使用，不要接入其他上行，以免产生第二条默认路由。方式 B 中服务器自身也要有指向主路由的默认网关；连接主路由的 LAN 口不能选为有线回程口。

详细的字段配置与拓扑图见 [info/README.md 第 3 节](info/README.md#3-服务器上行方式与三种角色的配置细节)。

## 有线回程

三种角色都支持可选的专用有线回程：

- 在网线两端的设备上都选择「有线回程端口」，并用网线连接这两个端口；两端都必须是运行本插件的 Mesh 设备。
- 所选端口必须是 LAN 网桥端口，不能是 WAN 口，也不能用于管理或普通 LAN 上行；应用后该端口会从 `br-lan` 移出，专用于 Mesh 回程。
- 网线连接时优先使用有线，网线拔出后自动切换到 Mesh 无线，恢复后自动切回有线。
- 如果只需要普通有线上行，请保持「有线回程端口」为「无」，按普通 LAN 口使用。

## 备份管理

「备份管理」标签页位于「运行日志」之前，用于保存和恢复整机的网络配置。备份是 `/etc/meshassistant/backup/` 下的 tar 归档，文件名形如 `20261105-143022.tar`，包含 `network`、`wireless`、`dhcp`、`firewall`、`system` 和 `meshassistant` 六份配置，以及记录创建时间、主机名、LAN 地址、角色和服务状态的清单。创建、恢复、删除和清空备份都会写入 `/tmp/meshassistant.log`，可在「运行日志」中查看。

- **创建备份**：立即把当前配置打包保存。
- **手动恢复**：从列表中选择一个备份恢复；存在多个备份时会显示下拉框。执行前会先自动备份当前配置，因此误恢复也可以再恢复回来。
- **删除备份**：删除选中的一个备份，操作前弹出确认对话框。
- **清空备份**：删除全部备份，操作前弹出确认对话框。

除了手动创建，点击「保存并应用」时页面会先把**执行保存之前的**当前配置自动备份一份，再写入表单；点击「重新应用 MESH助手设置」时，脚本在启用或关闭 Mesh 之前也会自动备份。因此每次应用都会留下一个快照，备份较多时可在标签页中清理。

恢复会写回六份配置、按备份清单恢复 `firewall`、`dnsmasq`、`odhcpd` 的启用状态和 Mesh 服务的运行状态，然后执行 `reload_config`、重新加载网络并重启无线。**恢复过程中连接可能中断，管理地址也可能改变**，请确保能通过网线或新地址重新访问设备。备份归档包含 WiFi 与 Mesh 密码，请妥善保管；目录权限为 0700，文件权限为 0600。

详细操作与注意事项见 [info/README.md 第 10 节](info/README.md#10-备份管理)。

## 注意事项

- **服务器**：一个 Mesh 中只应有一台服务器；可用 WAN 口接上游（服务器做 NAT 和 DHCP），也可用 LAN 口接上游（DHCP 复用，由主路由负责 NAT/DHCP，此时关闭「服务器提供 DHCP」）。详见[服务器上行方式](#服务器上行方式)。
- **主机名唯一**：整个 Mesh 中每台设备（含服务器）的主机名必须互不相同，否则状态页无法分清是哪台设备。页面按设备广播的 LAN 网桥 MAC 把各回程接口归组到同一台设备，只有报文不含该 MAC（旧版本设备）时才退回按主机名识别——这种情况下重名会让两台设备在列表中合并为一条，活动节点数也会少算。
- **节点 / 客户端**：不提供 DHCP/NAT；没有 DHCP 服务器或需要固定管理地址时，在「AP 模式」中配置静态 IP。以 DHCP 方式加入时，应用后脚本会复查 LAN 租约，未取得时在「Mesh 状态」页和运行日志中提示。原来的 `wwan` STA 应删除或禁用，避免保留竞争性的默认路由。
- **哑 AP 模式**：会更换管理地址、删除 WAN 并停用防火墙与 DHCP 服务。点击按钮后会先弹出确认对话框；操作前请备份配置，并确保能物理接触到设备。恢复命令为 `bash /etc/meshassistant/shell/meshassistant.sh undumb`。
- **可逆性**：启用/关闭 Mesh、有线回程端口和节点 LAN/主机名都会记录原值并在关闭时恢复，服务器写入的 DHCP 选项 6 也会在关闭时还原；安装和开机不会自动改动网络，默认配置为 `enabled=0`。

## 工作原理与安全

前端读取 UCI 与 `batctl n`，把表单写入 `/etc/config/meshassistant`，并通过 RPC 执行 `/etc/meshassistant/shell/meshassistant.sh`。浏览器不拼接 shell 命令；rpcd ACL 只允许固定的只读调用（如 `/usr/sbin/batctl n`、`linkinfo`、`capabilities`、`backup list`）和固定的写操作（`--detach`、`--detach dumbap`、`--detach backup restore`、`backup create`、`backup delete`、`backup clear`）。恢复时选择的归档名通过固定文件 `/tmp/meshassistant_backup_selection` 传递，不会把用户输入拼进命令行。UCI 权限为可读 `meshassistant`、`network`、`wireless`，只可写 `meshassistant`；对 `network`、`firewall`、`dhcp`、`system` 的修改全部在 root 脚本内部完成。

脚本以 `--detach` 在后台执行，避免 WiFi/网络重启导致 RPC 超时。服务器把 `bat0` 设为 `gw_mode=server` 并加入 LAN 桥；节点/客户端把 `bat0` 设为 `gw_mode=off`，停用 `firewall`、`dnsmasq`、`odhcpd` 并记录以便恢复。关闭 Mesh 时脚本只撤销自己记录过的改动。

## 主题与兼容性

- 支持 LuCI 亮色 / 暗色主题，无需手动切换：页面不包含自定义颜色或主题检测，只使用 LuCI 既有的 `cbi-*`、`.table`、`.alert-message` 等结构。
- 已适配 `luci-theme-bootstrap`（OpenWrt 24.10 / 25.12 默认主题）与 `luci-theme-argon` 2.x / 3.x。
- 兼容 OpenWrt / ImmortalWrt 24.10 与 25.12 的 JavaScript 版 LuCI，无需 `luci-compat`。
- 语言：英文为默认；安装 `luci-i18n-meshassistant-zh-cn` 后，菜单显示「MESH助手」，页面文字切换为简体中文。

## 依赖

- OpenWrt / ImmortalWrt 24.10 或 25.12，带 JavaScript 版 LuCI（`luci-base`）
- `kmod-batman-adv`、`batctl-default`、`luci-proto-batman-adv`：Batman-adv 内核模块、命令行工具与协议支持
- `kmod-cfg80211`：无线配置支持
- `dawn`：客户端漫游守护进程，在高级设置启用「客户端漫游（802.11k/v）」后由插件配置
- 完整版 wpad（`wpad-mbedtls`、`wpad-openssl`、`wpad-wolfssl` 或 `wpad-mesh-*`）：启用客户端漫游时必需；`wpad-basic-*` 不支持 802.11v
- `bash`：配置脚本使用 bash
- 至少一个支持 802.11s Mesh 的无线射频；推荐双频设备，用其中一个射频做普通 AP、另一个做 Mesh 回程

## 开发与测试

仓库自带一套无需安装依赖的 Node.js 测试套件：

```sh
node tests/run.js
```

测试覆盖配置脚本、页面逻辑、工具函数、翻译与打包文件；GitHub Actions 在打包发布前先运行同一套测试，测试失败时不会生成 Release。

## 许可证

GPL-3.0-only
