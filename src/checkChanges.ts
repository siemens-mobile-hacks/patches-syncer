import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { KibabAPI } from './KibabAPI.js';
import type { IndexData, PatchInfo } from './utils.js';

const argv = await yargs(hideBin(process.argv))
	.option('cookie', {
		type: 'string',
		description: 'Kibab cookie: login:password_hash',
		demandOption: true
	})
	.option('repo', {
		type: 'string',
		description: 'Patches repository.',
		default: 'siemens-mobile-hacks/patches'
	})
	.option('workflow', {
		type: 'string',
		description: 'Sync workflow.',
		default: 'sync-patches.yml'
	})
	.option('state', {
		type: 'string',
		description: 'File with the last triggered changes.',
		default: `${homedir()}/.cache/patches-syncer/changes.json`
	})
	.option('dry-run', {
		type: 'boolean',
		description: 'Only print changes.',
		default: false
	})
	.parse();

const token = process.env.GITHUB_TOKEN;
if (!token && !argv['dry-run']) {
	console.error('GITHUB_TOKEN is not set!');
	process.exit(1);
}

const known = await loadIndex();
const changed: number[] = [];
const deleted: number[] = [];
const seen = new Set<number>();

const [login, password] = argv.cookie.split(':');
const api = new KibabAPI(login, password);
for (const model of await api.getAllModels()) {
	for (const patch of await api.getAllPatches(model.modelId, model.swId)) {
		seen.add(patch.id);
		const old = known.get(patch.id);
		if (!old || patch.updated > moscowDay(old.mtime)) {
			console.log(`${model.name}: ${old ? 'updated' : 'added'} ${patch.id}`);
			changed.push(patch.id);
		}
	}
}

for (const [id, patch] of known) {
	if (!seen.has(id)) {
		console.log(`${patch.model}: deleted ${id}`);
		deleted.push(id);
	}
}

const state = JSON.stringify({ changed: changed.sort((a, b) => a - b), deleted: deleted.sort((a, b) => a - b) });
const lastState = existsSync(argv.state) ? readFileSync(argv.state, 'utf-8') : undefined;

if (changed.length === 0 && deleted.length === 0) {
	console.log('No changes.');
} else if (state === lastState) {
	console.log('Sync was already triggered for these changes.');
} else if (!argv['dry-run']) {
	await triggerSync(changed);
	console.log(`Triggered ${argv.workflow}.`);
}

if (!argv['dry-run']) {
	mkdirSync(dirname(argv.state), { recursive: true });
	writeFileSync(argv.state, state);
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

function moscowDay(time: number): string {
	return new Date(time).toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
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
