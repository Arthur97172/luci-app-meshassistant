'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('./lib');

function tmpdir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'meshassistant-mutation-'));
}

function runSuite(file, env) {
	const r = spawnSync(process.execPath, [ path.join(__dirname, file) ], {
		encoding: 'utf8',
		env: Object.assign({}, process.env, env || {})
	});

	return {
		status: r.status,
		output: (r.stdout || '') + (r.stderr || '')
	};
}

function copyPackage(dest) {
	for (const rel of [ 'Makefile', 'htdocs', 'po', 'root', '.github' ])
		fs.cpSync(path.join(lib.ROOT, rel), path.join(dest, rel), { recursive: true });
}

function expectFail(label, result) {
	lib.ok(result.status !== 0, label + ' fails the mutated suite');
	lib.ok(/FAIL|Error|ENOENT/.test(result.output),
		label + ' reports a failure', result.output.slice(0, 400));
}

{
	const dir = tmpdir();
	const target = path.join(dir, 'utils.js');
	const src = lib.read('htdocs/luci-static/resources/meshassistant/utils.js');
	fs.writeFileSync(target, src.replace(
		/const PLAIN_RE = [^;]+;/,
		'const PLAIN_RE = /^never$/;'));
	expectFail('parser regression', runSuite('utils.test.js', {
		MESHASSISTANT_UTILS_JS: target
	}));
	fs.rmSync(dir, { recursive: true, force: true });
}

{
	const dir = tmpdir();
	const target = path.join(dir, 'meshassistant.js');
	const src = lib.read('htdocs/luci-static/resources/view/meshassistant.js');
	fs.writeFileSync(target, src.replace(
		"runScript([ '--detach' ])",
		'runScript([])'));
	expectFail('button detach regression', runSuite('view.test.js', {
		MESHASSISTANT_VIEW_JS: target
	}));
	fs.rmSync(dir, { recursive: true, force: true });
}

{
	const dir = tmpdir();
	copyPackage(dir);
	const menuPath = path.join(dir, 'root/usr/share/luci/menu.d/luci-app-meshassistant.json');
	const menu = JSON.parse(fs.readFileSync(menuPath, 'utf8'));
	menu['admin/network/meshassistant'].title = 'Wrong Title';
	fs.writeFileSync(menuPath, JSON.stringify(menu, null, '\t'));
	expectFail('menu title regression', runSuite('i18n.test.js', {
		MESHASSISTANT_ROOT: dir
	}));
	fs.rmSync(dir, { recursive: true, force: true });
}

{
	const dir = tmpdir();
	copyPackage(dir);
	const aclPath = path.join(dir, 'root/usr/share/rpcd/acl.d/luci-app-meshassistant.json');
	const acl = JSON.parse(fs.readFileSync(aclPath, 'utf8'));
	delete acl['luci-app-meshassistant'].write.file[
		'/etc/meshassistant/shell/meshassistant.sh --detach dumbap'];
	fs.writeFileSync(aclPath, JSON.stringify(acl, null, '\t'));
	expectFail('ACL dumbap regression', runSuite('package.test.js', {
		MESHASSISTANT_ROOT: dir
	}));
	fs.rmSync(dir, { recursive: true, force: true });
}

{
	const dir = tmpdir();
	copyPackage(dir);
	fs.chmodSync(path.join(dir, 'root/etc/meshassistant/shell/meshassistant.sh'), 0o644);
	expectFail('script permission regression', runSuite('package.test.js', {
		MESHASSISTANT_ROOT: dir
	}));
	fs.rmSync(dir, { recursive: true, force: true });
}

{
	const dir = tmpdir();
	copyPackage(dir);
	const mkPath = path.join(dir, 'Makefile');
	const src = fs.readFileSync(mkPath, 'utf8');
	fs.writeFileSync(mkPath, src.replace(/^LUCI_URL:=.*\n/m, ''));
	expectFail('package URL regression', runSuite('package.test.js', {
		MESHASSISTANT_ROOT: dir
	}));
	fs.rmSync(dir, { recursive: true, force: true });
}

{
	const dir = tmpdir();
	copyPackage(dir);
	const viewPath = path.join(dir, 'htdocs/luci-static/resources/view/meshassistant.js');
	const src = fs.readFileSync(viewPath, 'utf8');
	fs.writeFileSync(viewPath, src.replace(
		'const BATCTL =',
		"const BAD_STYLE = 'color: #ff0000';\nconst BATCTL ="));
	expectFail('hardcoded color regression', runSuite('package.test.js', {
		MESHASSISTANT_ROOT: dir
	}));
	fs.rmSync(dir, { recursive: true, force: true });
}

lib.summary('mutation');
