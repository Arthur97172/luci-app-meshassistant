#
# Copyright (C) 2026 Arthur97172 <arthur97172@outlook.com>
#
# This is free software, licensed under the GNU General Public License v3.0
# (SPDX: GPL-3.0-only).
#

PKG_NAME:=luci-app-meshassistant
PKG_VERSION:=2.6.4
PKG_RELEASE:=1

PKG_LICENSE:=GPL-3.0-only
PKG_LICENSE_FILES:=LICENSE
PKG_MAINTAINER:=Arthur97172 <Arthur97172@users.noreply.github.com>

LUCI_URL:=https://github.com/Arthur97172/luci-app-meshassistant
LUCI_MAINTAINER:=Arthur97172 <Arthur97172@users.noreply.github.com>

include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI Support for mesh setup.
LUCI_DEPENDS:=+luci-base +kmod-cfg80211 +batctl-default +kmod-batman-adv +dawn +bash +luci-proto-batman-adv +socat +flock +iw

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
