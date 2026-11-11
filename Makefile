#
# Copyright (C) 2026 Arthur97172 <arthur97172@outlook.com>
#
# This is free software, licensed under the GNU General Public License v3.0
# (SPDX: GPL-3.0-only).
#

PKG_NAME:=luci-app-meshassistant
PKG_VERSION:=2.7.9
PKG_RELEASE:=1

PKG_LICENSE:=GPL-3.0-only
PKG_LICENSE_FILES:=LICENSE
PKG_MAINTAINER:=Arthur97172 <Arthur97172@users.noreply.github.com>

LUCI_URL:=https://github.com/Arthur97172/luci-app-meshassistant
LUCI_MAINTAINER:=Arthur97172 <Arthur97172@users.noreply.github.com>

include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI Support for mesh setup.
LUCI_DEPENDS:=+luci-base +kmod-cfg80211 +batctl-default +kmod-batman-adv +dawn +bash +luci-proto-batman-adv +socat +flock +iw

define Package/luci-app-meshassistant/postrm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] && exit 0
[ "$${PKG_UPGRADE}" = "1" ] && exit 0
rm -f /etc/config/meshassistant
rm -f /tmp/meshassistant_peers /tmp/meshassistant_names /tmp/meshassistant.log /tmp/meshassistant_backup_selection
rm -f /tmp/meshassistant_rdns /tmp/meshassistant_rdns.lock
# Put DAWN back the way it was before the plugin took it over, but only when
# the plugin actually managed it; a DAWN that the user configured is left
# alone.  The marker is created by setup_dawn().
if [ -f /etc/meshassistant/dawn_managed ]; then
	if [ -x /etc/init.d/dawn ]; then
		/etc/init.d/dawn stop >/dev/null 2>&1 || true
		/etc/init.d/dawn disable >/dev/null 2>&1 || true
	fi
	if [ -f /etc/meshassistant/dawn.backup ]; then
		cp /etc/meshassistant/dawn.backup /etc/config/dawn 2>/dev/null || true
	else
		rm -f /etc/config/dawn
	fi
	rm -f /etc/meshassistant/dawn_managed /etc/meshassistant/dawn.backup
fi
rm -f /tmp/luci-indexcache* 2>/dev/null || true
rm -rf /tmp/luci-modulecache/* 2>/dev/null || true
if [ -x /etc/init.d/rpcd ]; then
	/etc/init.d/rpcd restart >/dev/null 2>&1 || true
fi
exit 0
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
