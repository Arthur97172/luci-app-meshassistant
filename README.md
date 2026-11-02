# MESH助手（luci-app-meshassistant）

简体中文 | [English](README.en.md)

一个面向 OpenWrt / ImmortalWrt 的 Batman-adv Mesh 配置页面。在 LuCI 中选好角色、填写 SSID 与密码，点一下按钮即可把本机配置为 Mesh 服务器、节点或客户端；页面同时显示当前邻居节点状态。界面完全使用 JavaScript 实现，不依赖 `luci-compat`、`luci-lua-runtime` 或 `libiwinfo-lua`。

插件位于 **网络 → MESH助手**（`admin/network/meshassistant`；英文界面为 **Network → Easy Mesh**），页面标题为「MESH助手 WiFi 设置」。

## 功能

| 功能 | 说明 |
| --- | --- |
| 三种角色 | 服务器（Server，作为网关）、节点（Node）、客户端（Client） |
| 普通 AP + Mesh 回程 | 普通 WiFi 与 Mesh 回程可以分别选择射频；当前脚本的 Mesh 射频请只选一个 |
| Mesh 状态 | 读取 `batctl n`，显示活动节点数、接口、邻居节点和最后发现时间 |
| 后台应用 | 应用设置时脚本脱离页面在后台执行，避免 WiFi / 网络重启导致请求超时或页面掉线 |
| Dumb AP 模式 | 把节点切换为接入现有网络的哑 AP（会更换管理地址） |
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
   - **WiFi 网络 SSID**：普通 WiFi 接入点的名称。
   - **普通 AP 射频**：承载普通 WiFi 的射频。
   - **Mesh 射频**：承载 Mesh 回程的射频；当前脚本请只选一个（多选时不能可靠创建多个 Mesh 接口）。
   - **Mesh 网络 SSID**：同一 Mesh 中所有设备必须一致。
   - **密码保护 / Mesh 密码**：开启后，普通 AP 使用 WPA3 混合模式（`sae-mixed`），Mesh 回程使用 WPA3（`sae`）；密码至少 8 位。
3. 选择「节点」或「客户端」后，「AP 模式」标签页才会出现：
   - **节点主机名**：`node2` – `node9`。
   - **IP 模式 / 静态 IP 地址 / Mesh 网关 IP 地址 / IPv4 子网掩码 / DNS 服务器**：选择静态 IP 时填写。
   - **启用哑 AP 模式**：见下方警告。
4. 「高级设置」包含 K/V/R 开关、移动域（4 位十六进制）、良好 / 较差 RSSI 阈值。除非了解相关设置，否则保持默认值。
5. 点击页面底部的「保存并应用」。这一步只把表单写入 `/etc/config/meshassistant`，**还不会**改动系统网络。
6. 点击「重新应用 MESH助手设置」，脚本才会在当前配置下真正创建或删除 Mesh 网络。按钮按已保存的配置工作，所以请先保存；执行结果写入 `/tmp/meshassistant.log`。开关为关闭状态时，该按钮会尝试清理已创建的 Mesh 接口、删除 Batman 网络并重新加载网络。
7. 应用完成后刷新页面，顶部的「Mesh 状态」会显示活动节点数、接口、邻居节点和最后发现时间。读不到 `batctl` 输出时显示「无法读取 Mesh 状态」。

> 修改 Mesh SSID 或射频后再次应用，脚本会按当前和上一次记录的 Mesh SSID 尝试清理旧接口。

### Mesh 模式说明（服务器 / 节点 / 客户端）

「Mesh 模式」的三个选项对应脚本中的不同角色。两台或更多设备组网时，通常只选一台作为「服务器」，其余选「节点」。

| 项目 | 服务器 | 节点 | 客户端 |
| --- | --- | --- | --- |
| 脚本内部值 | `server` | `off` | `client` |
| `bat0` 网关模式 | `server` | `off` | `off` |
| 防火墙 / DHCP / DNS | 保留并工作 | 停用 | 停用 |
| `bat0` 加入 `br-lan` | 是 | 是 | 是 |
| `wan` 端口加入 `br-lan` | 否 | 是 | 是 |
| 「AP 模式」标签页 | 不显示 | 显示 | 显示 |
| 互联网上行 | 需要（若要上网） | 不需要 | 不需要 |
| 地址分配 | 本机 DHCP 服务器 | 由服务器分配或静态 | 由服务器分配或静态 |
| 典型用途 | 唯一网关 / 主设备 | 扩展 Mesh 覆盖 | 加入 Mesh 的非网关设备 |

**服务器（Server）**

- 作为 Mesh 的网关：脚本把 `bat0` 设为 `gw_mode=server`，加入 `br-lan`，并把防火墙 LAN 区域设为 `lan bat0`、WAN 区域设为 `wan mesh_batman`。
- 保留 `dnsmasq`、`firewall`、`odhcpd`，由它给整个 Mesh 提供 DHCP、DNS 和 NAT。
- 如果需要整个 Mesh 能上网，服务器必须有一台上行设备；典型是有线 WAN。若上行接口是 `wwan`（例如 WiFi STA），脚本不会自动把它放回 WAN 防火墙区域，启用后需在「网络 → 防火墙」把 `wwan` 加回 `wan` 区域，否则可能无法上网。
- 一个 Mesh 中只应有一台服务器。
- 「AP 模式」标签页不会出现；如果还需要普通 WiFi，在「基础设置」里选择「普通 AP 射频」。
- 如果完全不需要普通 AP：当前页面没有「无」选项，脚本只在 `wifi_radio` 为空时跳过 AP。可在 SSH 中执行 `uci set meshassistant.config.wifi_radio='' && uci commit meshassistant`，再运行 `/meshassistant/meshassistant.sh --detach`；之后不要在页面上再次「保存并应用」，否则会写回默认射频。已有的 `wifi_ap_*` 需要手动删除。

**节点（Node）**

- 作为 Mesh 的扩展点：脚本把 `bat0` 设为 `gw_mode=off`，删除防火墙区域（按 `@zone[0]`–`[2]` 依次删除），停用 `firewall`、`dnsmasq`、`odhcpd`，并把 `bat0` 和 `wan` 端口加入 `br-lan`。
- 节点不提供 DHCP/NAT，客户端由服务器分配地址；节点自身的 LAN 地址应设为与服务器同网段且不冲突的地址（例如服务器 `192.168.10.1`，节点 `192.168.10.2`）。
- 「AP 模式」标签页会出现，但其中的「静态 IP 地址 / 网关 / 子网掩码 / DNS」只有在点击「启用哑 AP 模式」时才会被脚本使用；普通启用不会自动修改 LAN 地址。要固定管理地址，请先在「网络 → 接口」修改 LAN，或使用哑 AP 模式。
- 节点不应保留 WAN 上行；如果设备上已有 `network.wan` 接口，先删除或改用哑 AP 模式，避免 `wan` 端口同时被当作 WAN 和 `br-lan` 成员。如果原来用 WiFi STA（`wwan`）上网，作为节点时应删除或禁用该 STA 接口，避免节点保留自己的默认路由。
- 一台 Mesh 可以有多台节点；所有节点的「Mesh 网络 SSID」和密码必须与服务器一致。

**客户端（Client）**

- 当前脚本中，`client` 与 `off`（节点）走完全相同的代码路径：`bat0` 为 `gw_mode=off`，防火墙/DHCP/DNS 停用，`bat0` 和 `wan` 加入 `br-lan`。
- 因此它和「节点」的实际配置效果一致，区别只在界面语义；只是扩展 Mesh 时选「节点」即可，只有在需要沿用原插件「客户端」语义时才选「客户端」。
- 「AP 模式」标签页和哑 AP 按钮同样会出现，使用注意事项与节点相同。

**两台设备的最简示例**

- 服务器：Mesh 模式选「服务器」，LAN 保持 `192.168.10.1`，接好互联网上行；选择一个 Mesh 射频（例如 `radio0`），填写 Mesh 网络 SSID 和密码。
- 节点：Mesh 模式选「节点」，LAN 改为 `192.168.10.2`（网关和 DNS 指向 `192.168.10.1`），删除或禁用原来的 `wwan` STA；Mesh 射频、Mesh 网络 SSID、密码与服务器完全一致。
- 先保存并应用服务器，再保存并应用节点；两边用 `batctl n` 或页面顶部的「Mesh 状态」确认邻居出现。

> 三者的共同要求：同一 Mesh 内「Mesh 网络 SSID」和密码必须一致；「Mesh 射频」目前请只选一个（多选在脚本中不能可靠创建多个 Mesh 接口）；修改射频或 SSID 后建议检查并清理旧的 `wifi_ap_*` / `mesh_*` 配置。

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
- **启用**（`enabled=1`）时：先尝试清理当前与上一次记录的 Mesh SSID 对应的旧接口，创建 `network.bat0`（`batadv`，BATMAN_V）和 `network.mesh_batman`（`batadv_hardif`），然后逐个配置选中的 Mesh 射频：
  - 普通 AP：创建 `wireless.wifi_ap_<radio>`，模式 `ap`，SSID 取「WiFi 网络 SSID」，接入 `lan`，启用 802.11r 并写入移动域；
  - Mesh 回程：创建 `wireless.mesh_<radio>`，模式 `mesh`（802.11s），实际 `mesh_id` 为「Mesh 网络 SSID」加上 `-mesh` 后缀，接入 `mesh_batman`；
  - 每个接口写入后执行 `wifi reload`，最后重启网络与无线。
- **服务器**角色：`bat0` 设为 `gw_mode=server`，加入 `br-lan` 桥，防火墙 LAN 区域包含 `lan bat0`，WAN 区域包含 `wan mesh_batman`。
- **节点 / 客户端**角色：`bat0` 设为 `gw_mode=off`，删除防火墙区域（按 `@zone[0]`–`[2]` 依次删除），把 `bat0` 和 `wan` 加入 `br-lan`，并停用 `dnsmasq`、`firewall`、`odhcpd`。这两种角色在脚本中走同一条处理路径。
- **关闭**（`enabled=0`）时：按当前和上一次的 Mesh SSID 尝试删除 Mesh / AP 接口，删除 `bat0` 与 `mesh_batman`，重新加载网络，但不恢复启用前的其他配置。

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
- 哑 AP 模式属于破坏性操作：会更换管理地址、删除 WAN 并停用防火墙与 DHCP 服务；脚本在操作前备份五份配置，必要时可用 `undumb` 恢复。
- 脚本日志位于 `/tmp/meshassistant.log`，可能包含 SSID、主机名和网络配置，请按需清理。
- 除 LuCI 管理界面外，本插件不额外开放端口或服务。

## 本地测试与设计文档

测试脚本与设计文档仅用于本地开发验证，保存在 `tests/` 和 `docs/` 目录中，**不包含在发布仓库中**。发布仓库只包含运行时代码、翻译、构建配置和 CI 工作流。

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
