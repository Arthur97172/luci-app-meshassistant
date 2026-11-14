'use strict';

const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const menuPath = 'root/usr/share/luci/menu.d/luci-app-meshassistant.json';
const aclPath = 'root/usr/share/rpcd/acl.d/luci-app-meshassistant.json';
const viewPath = 'htdocs/luci-static/resources/view/meshassistant.js';
const scriptPath = 'root/etc/meshassistant/shell/meshassistant.sh';

const menu = JSON.parse(lib.read(menuPath));
const entry = menu['admin/network/meshassistant'];

lib.ok(entry != null, 'menu entry exists');
lib.eq(entry.title, 'Mesh Assistant', 'menu title');
lib.eq(entry.order, 60, 'menu order');
lib.eq(entry.action, { type: 'view', path: 'meshassistant' }, 'menu action');
lib.eq(entry.depends.acl, [ 'luci-app-meshassistant' ], 'menu ACL dependency');
lib.eq(entry.depends.uci, { meshassistant: true }, 'menu UCI dependency');

const acl = JSON.parse(lib.read(aclPath))['luci-app-meshassistant'];

lib.ok(acl != null, 'ACL group exists');
lib.eq(acl.read.ubus.file, [ 'exec' ], 'read ubus file exec');
lib.eq(acl.read.ubus['luci-rpc'], [ 'getWirelessDevices' ],
	'read wireless devices RPC');
lib.eq(acl.read.ubus['network.interface'], [ 'status' ],
	'read LAN interface status RPC');
lib.eq(acl.read.ubus.iwinfo, [ 'freqlist', 'countrylist' ],
	'read iwinfo frequency and country lists');
lib.eq(acl.read.file['/usr/sbin/batctl n'], [ 'exec' ], 'batctl exec grant');
lib.eq(acl.read.file['/usr/sbin/batctl o'], [ 'exec' ],
	'batctl originator table exec grant');
lib.eq(acl.read.file['/etc/meshassistant/shell/meshassistant.sh linkinfo'], [ 'exec' ],
	'link info exec grant');
lib.eq(acl.read.file['/etc/meshassistant/shell/meshassistant.sh capabilities'], [ 'exec' ],
	'capabilities exec grant');
lib.eq(acl.read.file['/etc/meshassistant/shell/meshassistant.sh clients'], [ 'exec' ],
	'clients exec grant');
lib.eq(acl.read.file['/etc/meshassistant/shell/meshassistant.sh roaming'], [ 'exec' ],
	'roaming counters exec grant');
lib.eq(acl.read.file['/etc/meshassistant/shell/meshassistant.sh backup list'], [ 'exec' ],
	'backup list exec grant');
lib.eq(acl.read.file['/tmp/meshassistant_peers'], [ 'read' ],
	'peer announcement file read grant');
lib.eq(acl.read.file['/tmp/meshassistant.log'], [ 'read' ],
	'run log read grant');
lib.eq(acl.read.uci, [ 'meshassistant', 'network', 'wireless' ], 'read UCI grants');
lib.eq(acl.write.ubus.file, [ 'exec' ], 'write ubus file exec');
lib.eq(acl.write.file['/etc/meshassistant/shell/meshassistant.sh --detach'], [ 'exec' ],
	'detach exec grant');
lib.eq(acl.write.file['/etc/meshassistant/shell/meshassistant.sh --detach dumbap'], [ 'exec' ],
	'dumbap exec grant');
lib.eq(acl.write.file['/etc/meshassistant/shell/meshassistant.sh clearlog'], [ 'exec' ],
	'clear log exec grant');
lib.eq(acl.write.file['/etc/meshassistant/shell/meshassistant.sh backup create'], [ 'exec' ],
	'backup create exec grant');
lib.eq(acl.write.file['/etc/meshassistant/shell/meshassistant.sh backup delete'], [ 'exec' ],
	'backup delete exec grant');
lib.eq(acl.write.file['/etc/meshassistant/shell/meshassistant.sh backup clear'], [ 'exec' ],
	'backup clear exec grant');
lib.eq(acl.write.file['/etc/meshassistant/shell/meshassistant.sh --detach backup restore'], [ 'exec' ],
	'detached backup restore exec grant');
lib.eq(acl.write.file['/tmp/meshassistant_backup_selection'], [ 'write' ],
	'backup selection file write grant');
lib.eq(acl.write.uci, [ 'meshassistant' ], 'write UCI grant');

const mk = lib.read('Makefile');

lib.ok(/^PKG_VERSION:=2\.8\.0$/m.test(mk), 'version is 2.8.0');
lib.ok(/^PKG_RELEASE:=1$/m.test(mk), 'release is 1');
lib.ok(/^define Package\/luci-app-meshassistant\/postrm$/m.test(mk),
	'uninstall hook is defined');
lib.ok(/^rm -f \/etc\/config\/meshassistant$/m.test(mk),
	'uninstall removes the UCI config');
lib.ok(/^if \[ -f \/etc\/meshassistant\/dawn_managed \]; then$/m.test(mk),
	'uninstall only touches a DAWN config the plugin managed');
lib.ok(/^\t+\/etc\/init\.d\/dawn stop /m.test(mk), 'uninstall stops DAWN');
lib.ok(/^\t+\/etc\/init\.d\/dawn disable /m.test(mk), 'uninstall disables DAWN');
lib.ok(/^\t\tcp \/etc\/meshassistant\/dawn\.backup \/etc\/config\/dawn /m.test(mk),
	'uninstall restores the pre-existing DAWN config when there was one');
lib.ok(/^\t\trm -f \/etc\/config\/dawn$/m.test(mk),
	'uninstall removes the generated DAWN config when there was none');
lib.ok(/^\trm -f \/etc\/meshassistant\/dawn_managed \/etc\/meshassistant\/dawn\.backup$/m.test(mk),
	'uninstall drops the DAWN marker and backup');
lib.ok(/^\[ "\$\$\{PKG_UPGRADE\}" = "1" \] && exit 0$/m.test(mk),
	'uninstall hook is skipped on package upgrade');
lib.ok(/^#!\/bin\/sh\n\[ -n "\$\$\{IPKG_INSTROOT\}" \] && exit 0$/m.test(mk),
	'uninstall hook is skipped when building an image');
lib.ok(/\/etc\/init\.d\/rpcd restart/.test(mk),
	'uninstall restarts rpcd so LuCI sessions are logged out');
lib.ok(/^LUCI_DEPENDS:=.*\+luci-base/m.test(mk), 'depends on luci-base');
lib.ok(/^LUCI_DEPENDS:=.*\+bash/m.test(mk), 'depends on bash');
lib.ok(/^LUCI_DEPENDS:=.*\+socat/m.test(mk), 'depends on socat');
lib.ok(/^LUCI_DEPENDS:=.*\+iw/m.test(mk), 'depends on iw');
lib.ok(/^LUCI_DEPENDS:=.*\+flock/m.test(mk), 'depends on flock');
lib.ok(!/luci-compat|luci-lua-runtime|libiwinfo-lua/.test(mk),
	'no legacy Lua dependencies');

lib.eq(/^LUCI_URL:=(.+)$/m.exec(mk)?.[1],
	'https://github.com/Arthur97172/luci-app-meshassistant',
	'LUCI_URL points to the project repository');
lib.ok(/^LUCI_MAINTAINER:=Arthur97172 </m.test(mk),
	'LUCI_MAINTAINER is set (luci.mk otherwise stamps the LuCI defaults)');

lib.ok(!fs.existsSync(path.join(lib.ROOT, 'luasrc')), 'luasrc directory removed');

const script = lib.read(scriptPath);
const mode = fs.statSync(path.join(lib.ROOT, scriptPath)).mode;

lib.ok((mode & 0o111) !== 0, 'meshassistant.sh is executable');
lib.ok(/^if \[ "\$1" = "--detach" \]; then$/m.test(script), 'script has --detach branch');
lib.ok(script.includes('/etc/meshassistant/shell/meshassistant.sh "$@" >>"$MESHASSISTANT_LOG" 2>&1 &'),
	'--detach branch appends the run output to the log');
lib.ok(script.includes('log_append "Created backup: $BACKUP_LAST_CREATED"'),
	'backup create is recorded in the run log');
lib.ok(script.includes('log_append "Deleted backup: $BACKUP_LAST_DELETED"'),
	'backup delete is recorded in the run log');
lib.ok(script.includes('log_append "Deleted $BACKUP_LAST_COUNT backup(s)."'),
	'backup clear is recorded in the run log');
lib.ok(/log_note "Restoring backup: \$file"/.test(script),
	'backup restore is timestamped in the run log');
lib.ok(/^if \[ "\$1" = "daemon" \]; then$/m.test(script),
	'script has a daemon branch');
lib.ok(/^if \[ "\$1" = "peer" \]; then$/m.test(script),
	'script has a peer branch');
lib.ok(/^if \[ "\$1" = "linkinfo" \]; then$/m.test(script),
	'script has a linkinfo branch');
lib.ok(/^if \[ "\$1" = "clients" \]; then$/m.test(script),
	'script has a clients branch');
lib.ok(/^if \[ "\$1" = "roaming" \]; then$/m.test(script),
	'script has a roaming branch');
lib.ok(script.includes('brctl showmacs "$br"'),
	'clients reads the bridge forwarding table');
lib.ok(/\[ "\$iface" = "bat0" \] && continue/.test(script),
	'clients skips the bat0 port that carries remote mesh devices');
lib.ok(script.includes('client_reverse_name "$ip" "$gw"'),
	'clients without a lease ask the LAN gateway for a hostname');
lib.ok(script.includes("sort -k3,3 -k2,2"),
	'clients are sorted for stable output');
lib.ok(/^if \[ "\$1" = "clearlog" \]; then$/m.test(script),
	'script has a clearlog branch');
lib.ok(/^if \[ "\$1" = "backup" \]; then$/m.test(script),
	'script has a backup branch');
lib.ok(script.includes('MESHASSISTANT_BACKUP_DIR=/etc/meshassistant/backup') ||
	script.includes('MESHASSISTANT_BACKUP_DIR=${MESHASSISTANT_BACKUP_DIR:-/etc/meshassistant/backup}'),
	'backups default to /etc/meshassistant/backup');
lib.ok(script.includes('backup_create || log_note "Warning: the automatic backup failed; continuing."'),
	'the mesh apply creates an automatic backup before changing the configuration');
lib.ok(script.includes('iw dev "$iface" info'),
	'link info reads the hardif channel');
lib.ok(script.includes('iw dev "$iface" station dump'),
	'link info reads the station signal');
lib.ok(script.includes('socat -u - "UDP-DATAGRAM:$brd:$MESHASSISTANT_PORT,broadcast"'),
	'script broadcasts peer announcements');
lib.ok(script.includes('UDP-RECVFROM:$MESHASSISTANT_PORT,reuseaddr,fork'),
	'script listens for peer announcements');
lib.ok(script.includes('MESHASSISTANT_NAMES=/tmp/meshassistant_names'),
	'client names have their own announcement table');
lib.ok(script.includes('uci -q show dhcp'),
	'client names include the static host reservations');
lib.ok(script.includes('announce_names()'),
	'client names are broadcast to the other mesh devices');
lib.ok(script.includes('name_append "$ts $mac ${ip:--} $hostname"'),
	'a received client name is stored in the name table');
lib.ok(script.includes('prune_names()'),
	'expired client names are pruned');
lib.ok(/rm -f \/tmp\/meshassistant_peers \/tmp\/meshassistant_names/.test(mk),
	'uninstall removes the client name table');
lib.ok(/rm -f .*\/tmp\/meshassistant_rdns \/tmp\/meshassistant_rdns\.lock/.test(mk),
	'uninstall removes the reverse-DNS cache');

const initPath = 'root/etc/init.d/meshassistant';
const initMode = fs.statSync(path.join(lib.ROOT, initPath)).mode;
const init = lib.read(initPath);

lib.ok((initMode & 0o111) !== 0, 'peer service init script is executable');
lib.ok(init.includes('USE_PROCD=1'), 'peer service uses procd');
lib.ok(init.includes('/etc/meshassistant/shell/meshassistant.sh daemon'),
	'peer service runs the daemon subcommand');
lib.ok(init.includes('meshassistant.config.enabled'),
	'peer service only starts while the mesh is enabled');
lib.ok(init.includes('rm -f /tmp/meshassistant_names'),
	'stopping the service removes the announced client names');

const uciDefaultsMode = fs.statSync(
	path.join(lib.ROOT, 'root/etc/uci-defaults/luci-meshassistant')).mode;
lib.ok((uciDefaultsMode & 0o111) !== 0, 'uci-defaults script is executable');

const view = lib.read(viewPath);
const colorRe = /#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(|(?:^|[;{\s])(?:color|background(?:-color)?)\s*:/m;

lib.ok(!colorRe.test(view), 'view contains no hardcoded colors');

const workflow = lib.read('.github/workflows/build.yml');

lib.ok(/^\s{2}test:/m.test(workflow), 'workflow defines a test job');
lib.ok(/node tests\/run\.js/.test(workflow), 'workflow runs the local test suite');
lib.ok(/^\s{4}needs: test\r?$/m.test(workflow),
	'the build job depends on the tests');
lib.ok(/^\s{2}build:/m.test(workflow), 'workflow defines build job');

/*
 * The test suite only protects the build if it is part of the repository; a
 * local-only tests/ directory would leave CI with nothing to run.
 */
lib.ok(!/^tests\/\s*$/m.test(lib.read('.gitignore')),
	'the test suite is committed with the package');

/* A failed build must not delete the existing release and republish a
 * partial one: the release job runs only after success, and both package
 * formats are verified before the old release is removed. */
lib.ok(!/!cancelled\(\)/.test(workflow),
	'release job does not run after a failed build');
lib.ok(/^\s{4}if: \$\{\{ success\(\) \}\}\r?$/m.test(workflow),
	'release job requires a successful build');

const verifyStep = workflow.slice(
	workflow.indexOf('Verify artifacts'),
	workflow.indexOf('Generate release body'));

lib.ok(/compgen -G 'artifacts\/\*\.ipk'/.test(verifyStep),
	'release verifies the ipk artifact before deleting the old release');
lib.ok(/compgen -G 'artifacts\/\*\.apk'/.test(verifyStep),
	'release verifies the apk artifact before deleting the old release');

lib.summary('package');
