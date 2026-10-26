import { existsSync } from 'node:fs';
import { program } from '@commander-js/extra-typings';
import { Socks5ProxyAgent, setGlobalDispatcher } from 'undici';
import { KibabAPI, type KibabPatch } from './KibabAPI.js';
import type { IndexData, PatchInfo } from './utils.js';

const ENV_FILE = `${import.meta.dirname}/../.env`;
if (existsSync(ENV_FILE))
	process.loadEnvFile(ENV_FILE);

const argv = program
	.option('--repo <repo>', 'Patches repository.', 'siemens-mobile-hacks/patches')
	.option('--workflow <file>', 'Sync workflow.', 'sync-patches.yml')
	.option('--proxy <url>', 'SOCKS5 proxy: socks5://[user:password@]host:port')
	.option('--dry-run', 'Only print changes.', false)
	.parse()
	.opts();

const cookie = process.env.KIBAB_COOKIE;
if (!cookie) {
	console.error('KIBAB_COOKIE is not set!');
	process.exit(1);
}

const token = process.env.GITHUB_TOKEN;
if (!token && !argv.dryRun) {
	console.error('GITHUB_TOKEN is not set!');
	process.exit(1);
}

if (argv.proxy)
	setGlobalDispatcher(new Socks5ProxyAgent(argv.proxy));

const known = await loadIndex();
const changed: number[] = [];
const deleted: number[] = [];
const seen = new Set<number>();

const [login, password] = cookie.split(':');
const api = new KibabAPI(login, password);
// Same-day updates are checked only for recent patches, the script is expected to run at least daily.
const recentDay = moscowTime(Date.now() - 24 * 3600 * 1000).slice(0, 10);
const models = await api.getAllModels();
for (const [i, model] of models.entries()) {
	const patches = await api.getAllPatches(model.modelId, model.swId);
	let modelChanged = 0;
	for (const patch of patches) {
		seen.add(patch.id);
		const old = known.get(patch.id);
		if (!old || await isUpdated(patch, old)) {
			console.log(`${model.name}: ${old ? 'updated' : 'added'} ${patch.id}`);
			changed.push(patch.id);
			modelChanged++;
		}
	}
	console.log(`[${i + 1}/${models.length}] ${model.name}: ${patches.length} patches, ${modelChanged} changed`);
}

for (const [id, patch] of known) {
	if (!seen.has(id)) {
		console.log(`${patch.model}: deleted ${id}`);
		deleted.push(id);
	}
}

if (changed.length === 0 && deleted.length === 0) {
	console.log('No changes.');
} else if (argv.dryRun) {
	// Only print changes.
} else if (await isSyncRunning()) {
	console.log(`${argv.workflow} is not finished yet, skipping.`);
} else {
	await triggerSync(changed);
	console.log(`Triggered ${argv.workflow}.`);
}

async function loadIndex(): Promise<Map<number, PatchInfo>> {
	const response = await fetch(`https://raw.githubusercontent.com/${argv.repo}/main/patches/index.json`);
	if (!response.ok)
		throw new Error(`Can't load index.json: HTTP ${response.status}`);
	const index = await response.json() as IndexData;
	const patches = new Map<number, PatchInfo>();
	for (const model in index) {
		for (const patch of Object.values(index[model]))
			patches.set(+patch.id, patch);
	}
	return patches;
}

// The patch list has only the update date, so for a recent same-day update check the exact time.
async function isUpdated(patch: KibabPatch, old: PatchInfo): Promise<boolean> {
	const oldTime = moscowTime(old.mtime);
	if (patch.updated !== oldTime.slice(0, 10))
		return patch.updated > oldTime;
	if (patch.updated < recentDay)
		return false;
	const updateTime = await api.getPatchUpdateTime(patch.id);
	return updateTime !== undefined && updateTime > oldTime;
}

// Returns 'YYYY-MM-DD HH:MM' in Moscow time.
function moscowTime(time: number): string {
	return new Date(time).toLocaleString('sv-SE', { timeZone: 'Europe/Moscow' }).slice(0, 16);
}

async function isSyncRunning(): Promise<boolean> {
	const url = `https://api.github.com/repos/${argv.repo}/actions/workflows/${argv.workflow}/runs?per_page=20`;
	const response = await fetch(url, {
		headers: {
			'Accept': 'application/vnd.github+json',
			'Authorization': `Bearer ${token}`,
		},
	});
	if (!response.ok)
		throw new Error(`Can't get workflow runs: HTTP ${response.status} ${await response.text()}`);
	const { workflow_runs: runs } = await response.json() as { workflow_runs: { status: string }[] };
	return runs.some((run) => run.status !== 'completed');
}

async function triggerSync(patches: number[]): Promise<void> {
	const response = await fetch(`https://api.github.com/repos/${argv.repo}/actions/workflows/${argv.workflow}/dispatches`, {
		method: 'POST',
		headers: {
			'Accept': 'application/vnd.github+json',
			'Authorization': `Bearer ${token}`,
		},
		body: JSON.stringify({
			ref: 'main',
			inputs: patches.length > 0 ? { patches: patches.join(',') } : {},
		}),
	});
	if (response.status !== 204)
		throw new Error(`Can't trigger workflow: HTTP ${response.status} ${await response.text()}`);
}
