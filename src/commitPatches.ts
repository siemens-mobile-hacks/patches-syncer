import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { program } from '@commander-js/extra-typings';
import { buildFilesList, type IndexData, type PatchInfo } from './utils.js';

interface PatchChange {
	model: string;
	id: number;
	paths: string[];
	before?: PatchInfo;
	after?: PatchInfo;
	date: number;
}

const INDEX_PATH = 'patches/index.json';
const FILES_PATH = 'patches/files.json';
const BAD_PATH = 'bad.md';
const PATCH_FILE = /^patches\/([^/]+)\/([0-9]+)-[^/]+$/;
const MASS_CHANGE_LIMIT = 100;

const argv = program
	.option('--dry-run', 'Only print commits which would be created.', false)
	.parse()
	.opts();

const ROOT = process.cwd();
const TEMP_DIR = mkdtempSync(join(tmpdir(), 'commit-patches-'));
const TEMP_INDEX = join(TEMP_DIR, 'index');

try {
	commitPatches();
} finally {
	rmSync(TEMP_DIR, { recursive: true, force: true });
}

function commitPatches(): void {
	const head = git(['rev-parse', 'HEAD']).trim();
	git(['read-tree', head], true);
	git(['add', '-A', '--', 'patches', BAD_PATH], true);
	const changedPaths = git(['diff', '--cached', '--name-only', '--no-renames', '-z', head], true).split('\0').filter(Boolean);

	const oldIndex: IndexData = JSON.parse(git(['show', `${head}:${INDEX_PATH}`]));
	const newIndexText = readFileSync(`${ROOT}/${INDEX_PATH}`, 'utf-8');
	const newFilesText = readFileSync(`${ROOT}/${FILES_PATH}`, 'utf-8');
	const changes = collectChanges(changedPaths, oldIndex, JSON.parse(newIndexText));
	const badChanged = changedPaths.includes(BAD_PATH);

	const massChange = changes.length > MASS_CHANGE_LIMIT;
	if (massChange) {
		console.log(massChangeMessage(changes));
	} else {
		for (const change of changes)
			console.log(`${new Date(change.date * 1000).toISOString()} ${commitMessage(change)}`);
	}
	if (badChanged)
		console.log('Update bad patches list');

	if (argv.dryRun || (changes.length === 0 && !badChanged))
		return;

	git(['read-tree', head], true);
	let parent: string;
	if (massChange) {
		git(['add', '-A', '--', 'patches'], true);
		parent = commitTree(head, massChangeMessage(changes), Math.floor(Date.now() / 1000));
	} else {
		parent = commitEach(head, changes, oldIndex, newIndexText, newFilesText);
	}

	if (badChanged) {
		git(['add', '-A', '--', BAD_PATH], true);
		parent = commitTree(parent, 'Update bad patches list', Math.floor(Date.now() / 1000));
	}

	git(['update-ref', '-m', 'commit patches', 'HEAD', parent, head]);
	git(['reset', '-q']);

	const dirty = git(['status', '--porcelain', '--', 'patches', BAD_PATH]).trim();
	if (dirty)
		throw new Error(`Not all changes were committed:\n${dirty}`);
}

function commitEach(head: string, changes: PatchChange[], oldIndex: IndexData, newIndexText: string, newFilesText: string): string {
	const currentIndex: IndexData = structuredClone(oldIndex);
	let lastIndexText = JSON.stringify(currentIndex, null, '\t');
	let parent = head;

	for (let i = 0; i < changes.length; i++) {
		const change = changes[i];
		if (change.after) {
			currentIndex[change.model] = currentIndex[change.model] || {};
			currentIndex[change.model][change.id] = change.after;
		} else if (currentIndex[change.model]) {
			delete currentIndex[change.model][change.id];
		}

		const isLast = i === changes.length - 1;
		const indexText = isLast ? newIndexText : JSON.stringify(currentIndex, null, '\t');
		const filesText = isLast ? newFilesText : JSON.stringify(buildFilesList(currentIndex), null, '\t');

		if (change.paths.length > 0)
			git(['add', '-A', '--', ...change.paths], true);
		if (indexText !== lastIndexText) {
			stageText(INDEX_PATH, indexText);
			stageText(FILES_PATH, filesText);
			lastIndexText = indexText;
		}
		parent = commitTree(parent, commitMessage(change), change.date);
	}
	return parent;
}

function collectChanges(changedPaths: string[], oldIndex: IndexData, newIndex: IndexData): PatchChange[] {
	const changes = new Map<string, PatchChange>();
	const now = Math.floor(Date.now() / 1000);

	const getChange = (model: string, id: number): PatchChange => {
		const key = `${model}/${id}`;
		let change = changes.get(key);
		if (!change) {
			change = { model, id, paths: [], before: oldIndex[model]?.[id], after: newIndex[model]?.[id], date: now };
			changes.set(key, change);
		}
		return change;
	};

	for (const file of changedPaths) {
		if (file === INDEX_PATH || file === FILES_PATH || file === BAD_PATH)
			continue;
		const m = file.match(PATCH_FILE);
		if (!m)
			throw new Error(`Unexpected changed file: ${file}`);
		getChange(m[1], +m[2]).paths.push(file);
	}

	for (const model of new Set([...Object.keys(oldIndex), ...Object.keys(newIndex)])) {
		for (const id of new Set([...Object.keys(oldIndex[model] ?? {}), ...Object.keys(newIndex[model] ?? {})])) {
			if (JSON.stringify(oldIndex[model]?.[+id]) !== JSON.stringify(newIndex[model]?.[+id]))
				getChange(model, +id);
		}
	}

	for (const change of changes.values()) {
		if (change.after)
			change.date = Math.min(Math.floor(change.after.mtime / 1000), now);
	}

	return [...changes.values()].sort((a, b) => a.date - b.date || a.model.localeCompare(b.model, 'en') || a.id - b.id);
}

function patchFileName(change: PatchChange, patch?: PatchInfo): string {
	const name = basename(patch?.file ?? change.paths[0]);
	return name.startsWith(`${change.id}-`) ? name.slice(`${change.id}-`.length) : name;
}

function commitMessage(change: PatchChange): string {
	let text: string;
	if (!change.after) {
		text = `delete ${patchFileName(change, change.before)}`;
	} else if (!change.before) {
		text = `add ${patchFileName(change, change.after)}`;
	} else if (change.before.file !== change.after.file) {
		text = `rename ${patchFileName(change, change.before)} to ${patchFileName(change, change.after)}`;
	} else {
		text = `update ${patchFileName(change, change.after)}`;
	}
	return `${change.model}: ${text} (${change.id})`;
}

function massChangeMessage(changes: PatchChange[]): string {
	return `Update ${changes.length} patches`;
}

function stageText(file: string, text: string): void {
	const oid = git(['hash-object', '-w', '--stdin'], false, text).trim();
	git(['update-index', '--add', '--cacheinfo', `100644,${oid},${file}`], true);
}

function commitTree(parent: string, message: string, date: number): string {
	const tree = git(['write-tree'], true).trim();
	return git(['commit-tree', tree, '-p', parent, '-m', message], false, undefined, {
		GIT_AUTHOR_DATE: `${date} +0000`,
	}).trim();
}

function git(args: string[], tempIndex = false, input?: string, env: Record<string, string> = {}): string {
	const result = spawnSync('git', args, {
		cwd: ROOT,
		input,
		encoding: 'utf-8',
		maxBuffer: 256 * 1024 * 1024,
		env: {
			...process.env,
			...env,
			GIT_LITERAL_PATHSPECS: '1',
			...(tempIndex ? { GIT_INDEX_FILE: TEMP_INDEX } : {}),
		},
	});
	if (result.error)
		throw result.error;
	if (result.status !== 0)
		throw new Error(`git ${args.join(' ')} failed:\n${result.stderr}`);
	return result.stdout;
}
