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
| 普通 AP + Mesh 回程 | 普通 WiFi 与 Mesh 回程可以分别选择射频；Mesh 射频为单选 |
| 有线回程 | 可选择专用一个 LAN 口作为 Mesh 有线回程：插网线时使用有线，拔掉后自动改用 Mesh 无线 |
| Mesh 状态 | 读取 `batctl n` 及 Batman-adv 的转换表 / DAT 缓存，显示活动节点数、接口、邻居节点、邻居及其下游客户端的 IP 地址和最后发现时间 |
| 后台应用 | 应用设置时脚本脱离页面在后台执行，并只做非破坏性的网络 / 无线重载，避免请求超时或页面掉线 |
| Dumb AP 模式 | 把节点切换为接入现有网络的哑 AP（会更换管理地址，操作前有确认对话框） |
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
2. 在「基础设置」中选择 Mesh 模式，填写 WiFi 网络 SSID、普通 AP 射频、Mesh 射频、Mesh 网络 SSID 和密码。所有设备的 Mesh 射频、Mesh 网络 SSID 与密码必须一致。
3. 节点或客户端在「AP 模式」页设置主机名和 IP：LAN 上有 DHCP 服务器时可选 DHCP，没有 DHCP 或需要固定管理地址时选择静态 IP。
4. 需要有线回程时，在网线两端设备的「有线回程端口」中选择相连的 LAN 网桥端口；纯无线回程保持「无」。
5. 点击「保存并应用」，再点击「重新应用 MESH助手设置」。建议先配置服务器，再配置节点；执行日志位于 `/tmp/meshassistant.log`。
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
| 互联网上行 | 需要（若要上网） | 不需要 | 不需要 |
| 典型用途 | 唯一网关 / 主设备 | 扩展 Mesh 覆盖 | 加入 Mesh 的非网关设备 |

「客户端」与「节点」在当前脚本中走相同的代码路径，实际配置效果一致，区别只在界面语义。正常情况下扩展 Mesh 时选择「节点」即可。

## 有线回程

三种角色都支持可选的专用有线回程：

- 在网线两端的设备上都选择「有线回程端口」，并用网线连接这两个端口；两端都必须是运行本插件的 Mesh 设备。
- 所选端口必须是 LAN 网桥端口，不能是 WAN 口，也不能用于管理或普通 LAN 上行；应用后该端口会从 `br-lan` 移出，专用于 Mesh 回程。
- 网线连接时优先使用有线，网线拔出后自动切换到 Mesh 无线，恢复后自动切回有线。
- 如果只需要普通有线上行，请保持「有线回程端口」为「无」，按普通 LAN 口使用。

## 注意事项

- **服务器**：一个 Mesh 中只应有一台服务器；需要上网时，服务器必须有 WAN 或其他上行。LAN 上已有 DHCP 服务器时，关闭「服务器提供 DHCP」。
- **节点 / 客户端**：不提供 DHCP/NAT；没有 DHCP 服务器或需要固定管理地址时，在「AP 模式」中配置静态 IP。原来的 `wwan` STA 应删除或禁用，避免保留竞争性的默认路由。
- **哑 AP 模式**：会更换管理地址、删除 WAN 并停用防火墙与 DHCP 服务。点击按钮后会先弹出确认对话框；操作前请备份配置，并确保能物理接触到设备。恢复命令为 `bash /meshassistant/meshassistant.sh undumb`。
- **可逆性**：启用/关闭 Mesh、有线回程端口和节点 LAN/主机名都会记录原值并在关闭时恢复；安装和开机不会自动改动网络，默认配置为 `enabled=0`。

## 工作原理与安全

前端读取 UCI 与 `batctl n`，把表单写入 `/etc/config/meshassistant`，并通过 RPC 执行 `/meshassistant/meshassistant.sh`。浏览器不拼接 shell 命令；rpcd ACL 只允许 `/usr/sbin/batctl n`、`/meshassistant/meshassistant.sh --detach` 和 `/meshassistant/meshassistant.sh --detach dumbap` 三种调用。UCI 权限为可读 `meshassistant`、`network`、`wireless`，只可写 `meshassistant`；对 `network`、`firewall`、`dhcp`、`system` 的修改全部在 root 脚本内部完成。

脚本以 `--detach` 在后台执行，避免 WiFi/网络重启导致 RPC 超时。服务器把 `bat0` 设为 `gw_mode=server` 并加入 LAN 桥；节点/客户端把 `bat0` 设为 `gw_mode=off`，停用 `firewall`、`dnsmasq`、`odhcpd` 并记录以便恢复。关闭 Mesh 时脚本只撤销自己记录过的改动。

## 主题与兼容性

- 支持 LuCI 亮色 / 暗色主题，无需手动切换：页面不包含自定义 CSS、内联颜色或颜色检测，只使用 LuCI 既有的 `cbi-*`、`.table`、`.alert-message` 等结构。
- 已适配 `luci-theme-bootstrap`（OpenWrt 24.10 / 25.12 默认主题）与 `luci-theme-argon` 2.x / 3.x。
- 兼容 OpenWrt / ImmortalWrt 24.10 与 25.12 的 JavaScript 版 LuCI，无需 `luci-compat`。
- 语言：英文为默认；安装 `luci-i18n-meshassistant-zh-cn` 后，菜单显示「MESH助手」，页面文字切换为简体中文。

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
