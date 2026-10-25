#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ZERO_OID = '0'.repeat(40);
const TEMP_REF = 'refs/repack-history/tmp';
const PATCH_FILE = /^patches\/([^/]+)\/([^/]+)$/;
const SYNC_SUBJECT = /^sync( swilib)?$/;
const INDEX_PATH = 'patches/index.json';
const FILES_PATH = 'patches/files.json';
const BAD_PATH = 'bad.md';
const ARCHIVE_DIR = 'deleted/';
const CHUNK_SIZE = 50;
const HEADER_SPACING_COMMIT = 'e1b1c6bcdfb15956b4124e887898b5f2a24b64cf';

function usage(exitCode = 0) {
	const stream = exitCode === 0 ? process.stdout : process.stderr;
	stream.write(`Usage: node tools/repack-history.mjs [options]\n\n`);
	stream.write(`Splits history into one commit per patch change.\n\n`);
	stream.write(`Options:\n`);
	stream.write(`  --source <rev>    History to rewrite (default: HEAD)\n`);
	stream.write(`  --target <branch> New local branch (default: repacked-history)\n`);
	stream.write(`  --dry-run         Only analyze and print statistics\n`);
	stream.write(`  --help            Show this help\n`);
	process.exit(exitCode);
}

function parseArgs(argv) {
	const options = {
		source: 'HEAD',
		target: 'repacked-history',
		dryRun: false,
	};

	for (let i = 0; i < argv.length; i++) {
		switch (argv[i]) {
			case '--source':
				if (!argv[++i])
					usage(1);
				options.source = argv[i];
				break;
			case '--target':
				if (!argv[++i])
					usage(1);
				options.target = argv[i];
				break;
			case '--dry-run':
				options.dryRun = true;
				break;
			case '--help':
				usage();
				break;
			default:
				process.stderr.write(`Unknown option: ${argv[i]}\n`);
				usage(1);
		}
	}

	return options;
}

function git(args, { input, encoding = 'utf8', allowFailure = false } = {}) {
	const result = spawnSync('git', args, {
		input,
		encoding,
		maxBuffer: 256 * 1024 * 1024,
	});

	if (result.error)
		throw result.error;
	if (result.status !== 0 && !allowFailure)
		throw new Error(`git ${args.join(' ')} failed:\n${result.stderr.toString()}`);

	return result;
}

function gitText(args, options) {
	return git(args, options).stdout.trim();
}

function readBlob(oid, encoding = 'utf8') {
	return git(['cat-file', 'blob', oid], { encoding }).stdout;
}

function parseCommit(oid) {
	const object = readObject('commit', oid);
	const separator = object.indexOf('\n\n');
	const header = object.subarray(0, separator).toString('utf8');
	const message = object.subarray(separator + 2);
	const parents = [];
	let author;
	let committer;

	for (const line of header.split('\n')) {
		if (line.startsWith('parent ')) {
			parents.push(line.slice(7));
		} else if (line.startsWith('author ')) {
			author = parseIdentity(line.slice(7));
		} else if (line.startsWith('committer ')) {
			committer = parseIdentity(line.slice(10));
		}
	}

	const subject = message.toString('utf8').split('\n', 1)[0];
	return { parents, author, committer, message, subject };
}

function readObject(type, oid) {
	return git(['cat-file', type, oid], { encoding: 'buffer' }).stdout;
}

function parseIdentity(value) {
	const match = /^(.*) <([^>]*)> ([0-9]+) ([+-][0-9]{4})$/.exec(value);
	return { name: match[1], email: match[2], date: `${match[3]} ${match[4]}` };
}

function splitNul(buffer) {
	const fields = [];
	let start = 0;
	for (let i = 0; i < buffer.length; i++) {
		if (buffer[i] === 0) {
			fields.push(buffer.subarray(start, i).toString('utf8'));
			start = i + 1;
		}
	}
	return fields;
}

function readDelta(oid, parent) {
	const args = ['diff-tree', '--no-commit-id', '--raw', '-r', '-z', '--no-renames'];
	if (parent) {
		args.push(parent, oid);
	} else {
		args.push('--root', oid);
	}

	const fields = splitNul(git(args, { encoding: 'buffer' }).stdout);
	const changes = [];
	for (let i = 0; i < fields.length; i += 2) {
		const [oldMode, newMode, oldOid, newOid, status] = fields[i].slice(1).split(' ');
		changes.push({ oldMode, newMode, oldOid, newOid, status, path: fields[i + 1] });
	}
	return changes;
}

function readTree(oid) {
	const entries = [];
	for (const field of splitNul(git(['ls-tree', '-r', '-z', '--full-tree', oid], { encoding: 'buffer' }).stdout)) {
		const [, mode, entryOid, path] = /^([0-7]{6}) [a-z]+ ([0-9a-f]+)\t(.*)$/s.exec(field);
		entries.push({ mode, oid: entryOid, path });
	}
	return entries;
}

const indexCache = new Map();

function readIndex(oid) {
	if (!oid)
		return { data: {}, owners: new Map() };

	let index = indexCache.get(oid);
	if (index)
		return index;

	const data = JSON.parse(readBlob(oid));
	const owners = new Map();
	for (const patches of Object.values(data)) {
		for (const [id, entry] of Object.entries(patches)) {
			if (entry.file)
				owners.set(entry.file, id);
			if (entry.additionalFile)
				owners.set(entry.additionalFile, id);
		}
	}

	index = { data, owners };
	if (indexCache.size >= 4)
		indexCache.delete(indexCache.keys().next().value);
	indexCache.set(oid, index);
	return index;
}

function stripId(name, id) {
	return name.startsWith(`${id}-`) ? name.slice(id.length + 1) : name;
}

function entryFileName(file, id) {
	return stripId(file.slice(file.indexOf('/') + 1), id);
}

function patchPath(model, id, name) {
	return `patches/${model}/${id}-${name}`;
}

function identifyPatchFile(change, model, name, indexes) {
	for (const index of indexes) {
		const id = index.owners.get(`${model}/${name}`);
		if (id)
			return { id, name: stripId(name, id) };
	}

	const prefixed = /^([0-9]+)-(.+)$/.exec(name);
	if (prefixed)
		return { id: prefixed[1], name: prefixed[2] };

	if (name.toLowerCase().endsWith('.vkp')) {
		const id = /;PatchID:\s*([0-9]+)/i.exec(readBlob(change.newOid, 'latin1'))?.[1];
		if (id)
			return { id, name };
	}

	throw new Error(`Cannot identify patch for ${change.path}`);
}

function blobOid(content) {
	return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

function addHeaderSpacing(content) {
	const lines = content.toString('latin1').split('\n');
	const end = lines.indexOf('*/');
	if (end < 0)
		return undefined;
	lines.splice(end + 1, 0, '');
	return Buffer.from(lines.join('\n'), 'latin1');
}

function versionKey(key, files) {
	const parts = [...files.keys()].sort()
		.map((name) => `${name}\0${files.get(name).mode}\0${files.get(name).oid}`);
	return `${key}\0${parts.join('\0')}`;
}

function fileDigest(mode, oid, path) {
	return BigInt(`0x${createHash('sha1').update(`${mode} ${oid}\t${path}`).digest('hex')}`);
}

function isPatchData(path) {
	return PATCH_FILE.test(path) || path === INDEX_PATH || path === FILES_PATH || path.startsWith(ARCHIVE_DIR);
}

function analyze(source) {
	const commits = gitText(['rev-list', '--reverse', '--topo-order', source]).split('\n');
	const mainline = new Set(gitText(['rev-list', '--first-parent', source]).split('\n'));
	const state = new Map();
	const versions = new Map();
	const entries = new Map();
	const owners = new Map();
	const records = [];
	const blobs = new Map();
	const respaced = new Map();
	const stats = { archiveChanges: 0, respacedBlobs: 0 };
	let indexOid;
	let digest = 0n;
	let headerSpacing = mainline.has(HEADER_SPACING_COMMIT);

	function patchBlob(name, oid) {
		if (!headerSpacing || !name.toLowerCase().endsWith('.vkp'))
			return oid;

		let result = respaced.get(oid);
		if (result)
			return result;

		const content = addHeaderSpacing(readObject('blob', oid));
		result = oid;
		if (content) {
			result = blobOid(content);
			blobs.set(result, content);
			stats.respacedBlobs++;
		}
		respaced.set(oid, result);
		return result;
	}

	function recordEntry(key, id, entry) {
		const version = versions.get(key);
		if (entry?.file && version && state.get(key).has(entryFileName(entry.file, id)))
			entries.set(version, entry);
	}

	for (let position = 0; position < commits.length; position++) {
		const oid = commits[position];
		const commit = parseCommit(oid);
		const changes = readDelta(oid, commit.parents[0]);
		if (oid === HEADER_SPACING_COMMIT)
			headerSpacing = false;

		const record = {
			oid,
			commit,
			mainline: mainline.has(oid),
			sync: SYNC_SUBJECT.test(commit.subject),
			events: [],
			remainder: [],
			badList: [],
		};
		records.push(record);

		if (!record.mainline) {
			const patchChange = changes.find((change) => isPatchData(change.path));
			if (patchChange)
				throw new Error(`Side branch commit ${oid} changes ${patchChange.path}`);
			record.remainder = changes;
			continue;
		}

		const oldIndex = readIndex(indexOid);
		const indexChange = changes.find((change) => change.path === INDEX_PATH);
		if (indexChange)
			indexOid = indexChange.status === 'D' ? undefined : indexChange.newOid;
		const newIndex = readIndex(indexOid);
		const touched = new Map();

		for (const change of changes) {
			if (change.path === INDEX_PATH || change.path === FILES_PATH)
				continue;

			if (change.path.startsWith(ARCHIVE_DIR)) {
				stats.archiveChanges++;
				continue;
			}

			if (change.path === BAD_PATH && record.sync) {
				record.badList.push(change);
				continue;
			}

			const match = PATCH_FILE.exec(change.path);
			if (!match) {
				record.remainder.push(change);
				continue;
			}

			const [, model, filename] = match;
			let owner = owners.get(change.path);
			if (!owner) {
				if (change.status !== 'A')
					throw new Error(`Unknown patch file in ${oid}: ${change.path}`);
				owner = identifyPatchFile(change, model, filename, [newIndex, oldIndex]);
				owners.set(change.path, owner);
			} else if (change.status === 'D') {
				owners.delete(change.path);
			}

			const { id, name } = owner;
			const key = `${model}/${id}`;
			let patch = touched.get(key);
			if (!patch) {
				patch = { model, id, removed: [], added: [] };
				touched.set(key, patch);
			}

			if (change.status === 'D') {
				patch.removed.push(name);
			} else {
				patch.added.push({ name, mode: change.newMode, oid: patchBlob(name, change.newOid) });
			}
		}

		for (const [key, patch] of touched) {
			const before = state.get(key) ?? new Map();
			const after = new Map(before);
			for (const name of patch.removed) {
				if (!after.delete(name))
					throw new Error(`Deleted file is unknown in ${oid}: ${key} ${name}`);
			}
			for (const { name, ...file } of patch.added)
				after.set(name, file);

			for (const [name, file] of [...before, ...after])
				digest ^= fileDigest(file.mode, file.oid, patchPath(patch.model, patch.id, name));

			const beforeVersion = versions.get(key);
			const afterVersion = after.size > 0 ? versionKey(key, after) : undefined;
			if (after.size > 0) {
				state.set(key, after);
				versions.set(key, afterVersion);
			} else {
				state.delete(key);
				versions.delete(key);
			}

			if (beforeVersion !== afterVersion)
				record.events.push({ model: patch.model, id: patch.id, before, after, beforeVersion, afterVersion });
		}

		if (indexChange) {
			for (const [model, patches] of Object.entries(newIndex.data)) {
				for (const [id, entry] of Object.entries(patches))
					recordEntry(`${model}/${id}`, id, entry);
			}
		} else {
			for (const event of record.events)
				recordEntry(`${event.model}/${event.id}`, event.id, newIndex.data[event.model]?.[event.id]);
		}

		if (commit.parents.length > 1 && record.events.length > 0)
			throw new Error(`Merge commit ${oid} changes patches`);
		record.digest = digest;

		if ((position + 1) % 100 === 0 || position + 1 === commits.length)
			process.stderr.write(`Analyzed ${position + 1}/${commits.length} commits\n`);
	}

	for (const record of records) {
		for (const event of record.events) {
			event.entry = entries.get(event.afterVersion);
			event.beforeEntry = entries.get(event.beforeVersion);
			event.action = eventAction(event);
			event.date = eventDate(event, record.commit);
			event.message = eventMessage(event);
		}
		record.events.sort(compareEvents);
	}

	return { records, blobs, stats };
}

function mainFileName(files, entry, id) {
	if (entry?.file) {
		const name = entryFileName(entry.file, id);
		if (files.has(name))
			return name;
	}
	const names = [...files.keys()].sort();
	return names.find((name) => name.toLowerCase().endsWith('.vkp')) ?? names[0];
}

function eventAction(event) {
	if (event.before.size === 0)
		return 'add';
	if (event.after.size === 0)
		return 'delete';
	const before = mainFileName(event.before, event.beforeEntry, event.id);
	const after = mainFileName(event.after, event.entry, event.id);
	return before !== after ? 'rename' : 'update';
}

function eventMessage(event) {
	let text;
	switch (event.action) {
		case 'add':
		case 'update':
			text = `${event.action} ${mainFileName(event.after, event.entry, event.id)}`;
			break;
		case 'delete':
			text = `delete ${mainFileName(event.before, event.beforeEntry, event.id)}`;
			break;
		case 'rename': {
			const before = mainFileName(event.before, event.beforeEntry, event.id);
			const after = mainFileName(event.after, event.entry, event.id);
			text = `rename ${before} to ${after}`;
			break;
		}
	}
	return Buffer.from(`${event.model}: ${text} (${event.id})\n`, 'utf8');
}

function eventDate(event, commit) {
	if (!event.entry?.mtime)
		return commit.author.date;
	const syncSeconds = Number(commit.committer.date.split(' ')[0]);
	return `${Math.min(Math.floor(event.entry.mtime / 1000), syncSeconds)} +0000`;
}

function compareEvents(a, b) {
	return Number(a.date.split(' ')[0]) - Number(b.date.split(' ')[0]) ||
		a.model.localeCompare(b.model, 'en') ||
		Number(a.id) - Number(b.id);
}

function normalizeEntry(entry, model, id) {
	const normalized = {};
	for (const [key, value] of Object.entries(entry)) {
		if (key === 'id') {
			normalized.id = Number(id);
		} else if (key === 'file' || key === 'additionalFile') {
			normalized[key] = `${model}/${id}-${entryFileName(value, id)}`;
		} else {
			normalized[key] = value;
		}
	}
	return normalized;
}

function createCatalog(modelOrder) {
	const order = [...modelOrder];
	const known = new Set(order);
	const models = new Map();
	const chunks = new Map();
	const files = [];

	function set(model, id, entry) {
		if (!known.has(model)) {
			known.add(model);
			order.push(model);
		}

		let patches = models.get(model);
		if (entry) {
			if (!patches) {
				patches = new Map();
				models.set(model, patches);
			}
			patches.set(Number(id), entry);
		} else if (patches) {
			patches.delete(Number(id));
			if (patches.size === 0)
				models.delete(model);
		}
		chunks.delete(model);

		const position = Number(id);
		delete files[position];
		for (const name of order) {
			const owner = models.get(name)?.get(position);
			if (owner)
				files[position] = owner.additionalFile ? [owner.file, owner.additionalFile] : [owner.file];
		}
		while (files.length > 0 && files[files.length - 1] === undefined)
			files.length--;
	}

	function indexText() {
		const parts = [];
		for (const model of order) {
			const patches = models.get(model);
			if (!patches)
				continue;

			let chunk = chunks.get(model);
			if (chunk === undefined) {
				const object = {};
				for (const id of [...patches.keys()].sort((a, b) => a - b))
					object[id] = patches.get(id);
				chunk = `\t${JSON.stringify(model)}: ${JSON.stringify(object, null, '\t').replace(/\n/g, '\n\t')}`;
				chunks.set(model, chunk);
			}
			parts.push(chunk);
		}
		return parts.length > 0 ? `{\n${parts.join(',\n')}\n}` : '{}';
	}

	function filesText() {
		return JSON.stringify(files, null, '\t');
	}

	return { set, indexText, filesText };
}

function quotePath(path) {
	if (!/["\\\n]/.test(path))
		return path;
	return `"${path.replace(/[\\"]/g, '\\$&').replace(/\n/g, '\\n')}"`;
}

function createImporter(marksFile) {
	const child = spawn('git', ['fast-import', '--quiet', '--done', '--date-format=raw', `--export-marks=${marksFile}`], {
		stdio: ['pipe', 'inherit', 'inherit'],
	});
	const exited = once(child, 'exit');
	let nextMark = 1;

	async function write(...parts) {
		const buffer = Buffer.concat(parts.map((part) => Buffer.isBuffer(part) ? part : Buffer.from(part, 'utf8')));
		if (!child.stdin.write(buffer))
			await once(child.stdin, 'drain');
	}

	function data(content) {
		const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
		return [`data ${buffer.length}\n`, buffer, '\n'];
	}

	async function blob(content) {
		const mark = nextMark++;
		await write(`blob\nmark :${mark}\n`, ...data(content));
		return mark;
	}

	async function commit({ author, committer, message, from, merges = [], operations }) {
		const mark = nextMark++;
		const head = [
			`commit ${TEMP_REF}\n`,
			`mark :${mark}\n`,
			`author ${author.name} <${author.email}> ${author.date}\n`,
			`committer ${committer.name} <${committer.email}> ${committer.date}\n`,
		];
		const tail = [];
		if (from)
			tail.push(`from :${from}\n`);
		for (const merge of merges)
			tail.push(`merge :${merge}\n`);
		for (const operation of operations) {
			if (operation.delete) {
				tail.push(`D ${quotePath(operation.path)}\n`);
			} else {
				tail.push(`M ${operation.mode} ${operation.ref} ${quotePath(operation.path)}\n`);
			}
		}
		await write(...head, ...data(message), ...tail, '\n');
		return mark;
	}

	async function finish() {
		await write('done\n');
		child.stdin.end();
		const [code] = await exited;
		if (code !== 0)
			throw new Error(`git fast-import exited with code ${code}`);
	}

	return { blob, commit, finish };
}

function changeOperations(changes) {
	return changes.map((change) => change.status === 'D' ?
		{ path: change.path, delete: true } :
		{ path: change.path, mode: change.newMode, ref: change.newOid });
}

function eventOperations(event) {
	const operations = [];
	for (const name of event.before.keys()) {
		if (!event.after.has(name))
			operations.push({ path: patchPath(event.model, event.id, name), delete: true });
	}
	for (const [name, file] of event.after) {
		const old = event.before.get(name);
		if (old?.mode !== file.mode || old?.oid !== file.oid)
			operations.push({ path: patchPath(event.model, event.id, name), mode: file.mode, ref: file.oid });
	}
	return operations;
}

async function emit(records, blobs, source, marksFile) {
	const headIndex = readIndex(gitText(['rev-parse', `${source}:${INDEX_PATH}`]));
	const catalog = createCatalog(Object.keys(headIndex.data));
	const importer = createImporter(marksFile);
	const marks = new Map();
	const blobMarks = new Map();
	const checkpoints = [];
	const stats = { commits: 0, missingEntries: 0 };
	let lastIndex;
	let lastFiles;
	let tip;

	async function importBlobs(operations) {
		for (const operation of operations) {
			const content = blobs.get(operation.ref);
			if (!content)
				continue;
			if (!blobMarks.has(operation.ref))
				blobMarks.set(operation.ref, await importer.blob(content));
			operation.ref = `:${blobMarks.get(operation.ref)}`;
		}
	}

	function setEntry(event) {
		if (event.afterVersion && !event.entry)
			stats.missingEntries++;
		catalog.set(event.model, event.id, event.entry && normalizeEntry(event.entry, event.model, event.id));
	}

	for (let position = 0; position < records.length; position++) {
		const { oid, commit, mainline, events, remainder, badList, digest } = records[position];
		const merges = commit.parents.slice(1).map((parent) => marks.get(parent));

		if (!mainline) {
			const from = marks.get(commit.parents[0]);
			marks.set(oid, await importer.commit({ ...commit, from, merges, operations: changeOperations(remainder) }));
			stats.commits++;
			continue;
		}

		if (commit.parents.length === 0) {
			const operations = [...changeOperations(remainder), ...changeOperations(badList)];
			for (const event of events) {
				setEntry(event);
				operations.push(...eventOperations(event));
			}
			await importBlobs(operations);
			lastIndex = catalog.indexText();
			lastFiles = catalog.filesText();
			operations.push(
				{ path: INDEX_PATH, mode: '100644', ref: `:${await importer.blob(lastIndex)}` },
				{ path: FILES_PATH, mode: '100644', ref: `:${await importer.blob(lastFiles)}` },
			);
			tip = await importer.commit({ ...commit, message: Buffer.from('Initial sync\n', 'utf8'), operations });
			stats.commits++;
			marks.set(oid, tip);
			checkpoints.push({ oid, mark: tip, digest });
			continue;
		}

		if (remainder.length > 0 || merges.length > 0) {
			tip = await importer.commit({ ...commit, from: tip, merges, operations: changeOperations(remainder) });
			stats.commits++;
		}

		for (let start = 0; start < events.length; start += CHUNK_SIZE) {
			const chunk = events.slice(start, start + CHUNK_SIZE).map((event) => {
				setEntry(event);
				const indexText = catalog.indexText();
				const filesText = catalog.filesText();
				const step = {
					event,
					operations: eventOperations(event),
					indexText: indexText !== lastIndex ? indexText : undefined,
					filesText: filesText !== lastFiles ? filesText : undefined,
				};
				lastIndex = indexText;
				lastFiles = filesText;
				return step;
			});

			for (const step of chunk)
				await importBlobs(step.operations);

			for (const step of chunk) {
				if (step.filesText !== undefined)
					step.filesMark = await importer.blob(step.filesText);
			}
			for (const step of chunk) {
				if (step.indexText !== undefined)
					step.indexMark = await importer.blob(step.indexText);
			}

			for (const step of chunk) {
				if (step.indexMark)
					step.operations.push({ path: INDEX_PATH, mode: '100644', ref: `:${step.indexMark}` });
				if (step.filesMark)
					step.operations.push({ path: FILES_PATH, mode: '100644', ref: `:${step.filesMark}` });
				tip = await importer.commit({
					author: { ...commit.author, date: step.event.date },
					committer: commit.committer,
					message: step.event.message,
					from: tip,
					operations: step.operations,
				});
				stats.commits++;
			}
		}

		if (badList.length > 0) {
			tip = await importer.commit({
				...commit,
				message: Buffer.from('Update bad patches list\n', 'utf8'),
				from: tip,
				operations: changeOperations(badList),
			});
			stats.commits++;
		}

		marks.set(oid, tip);
		checkpoints.push({ oid, mark: tip, digest });

		if ((position + 1) % 100 === 0 || position + 1 === records.length)
			process.stderr.write(`Written ${position + 1}/${records.length} commits\n`);
	}

	await importer.finish();

	const oids = new Map();
	for (const line of readFileSync(marksFile, 'utf8').trim().split('\n')) {
		const [mark, markOid] = line.split(' ');
		oids.set(Number(mark.slice(1)), markOid);
	}

	return {
		tip: oids.get(marks.get(source)),
		checkpoints: checkpoints.map((checkpoint) => ({ ...checkpoint, rewritten: oids.get(checkpoint.mark) })),
		stats,
	};
}

function verify(source, tip, checkpoints) {
	const expectedTree = gitText(['rev-parse', `${source}^{tree}`]);
	const actualTree = gitText(['rev-parse', `${tip}^{tree}`]);
	if (actualTree !== expectedTree) {
		const drift = gitText(['diff-tree', '-r', '--name-only', source, tip]);
		throw new Error(`Final tree mismatch: ${actualTree} != ${expectedTree}\n${drift}`);
	}

	const otherFiles = (entries) => entries
		.filter((entry) => !isPatchData(entry.path))
		.map((entry) => `${entry.mode} ${entry.oid}\t${entry.path}`)
		.join('\n');

	for (let position = 0; position < checkpoints.length; position++) {
		const { oid, rewritten, digest } = checkpoints[position];
		const original = readTree(oid);
		const result = readTree(rewritten);

		if (otherFiles(original) !== otherFiles(result))
			throw new Error(`Non-patch files differ between ${oid} and ${rewritten}`);

		let actual = 0n;
		for (const entry of result) {
			if (PATCH_FILE.test(entry.path))
				actual ^= fileDigest(entry.mode, entry.oid, entry.path);
		}
		if (actual !== digest)
			throw new Error(`Patch files differ between ${oid} and ${rewritten}`);

		if ((position + 1) % 100 === 0 || position + 1 === checkpoints.length)
			process.stderr.write(`Verified ${position + 1}/${checkpoints.length} checkpoints\n`);
	}
}

function printPlan(records, stats) {
	const actions = { add: 0, update: 0, rename: 0, delete: 0 };
	let other = 0;
	let bad = 0;
	for (const record of records) {
		for (const event of record.events)
			actions[event.action]++;
		if (!record.mainline || record.remainder.length > 0 || record.commit.parents.length > 1)
			other++;
		if (record.badList.length > 0)
			bad++;
	}

	process.stdout.write(`Source commits: ${records.length}\n`);
	for (const [action, count] of Object.entries(actions))
		process.stdout.write(`Patch ${action}: ${count}\n`);
	process.stdout.write(`Other commits: ${other}\n`);
	process.stdout.write(`Bad patches list updates: ${bad}\n`);
	process.stdout.write(`Dropped ${ARCHIVE_DIR} changes: ${stats.archiveChanges}\n`);
	process.stdout.write(`Respaced old .vkp versions: ${stats.respacedBlobs}\n`);

	const largest = records.filter((record) => record.events.length > 0)
		.sort((a, b) => b.events.length - a.events.length)
		.slice(0, 5);
	for (const record of largest)
		process.stdout.write(`  ${record.oid.slice(0, 10)} ${record.commit.subject}: ${record.events.length} patch commits\n`);
}

async function rewrite(options) {
	const source = gitText(['rev-parse', '--verify', `${options.source}^{commit}`]);
	if (git(['check-ref-format', '--branch', options.target], { allowFailure: true }).status !== 0)
		throw new Error(`Invalid target branch name: ${options.target}`);

	const targetRef = `refs/heads/${options.target}`;
	if (!options.dryRun && git(['show-ref', '--verify', '--quiet', targetRef], { allowFailure: true }).status === 0)
		throw new Error(`Target branch already exists: ${options.target}`);

	const { records, blobs, stats } = analyze(source);
	printPlan(records, stats);
	if (options.dryRun) {
		process.stdout.write(`Dry run complete; no refs were changed.\n`);
		return;
	}

	const tempDir = mkdtempSync(join(tmpdir(), 'repack-history-'));
	try {
		git(['update-ref', '-d', TEMP_REF], { allowFailure: true });
		const result = await emit(records, blobs, source, join(tempDir, 'marks'));
		git(['update-ref', '-d', TEMP_REF]);
		process.stdout.write(`Written commits: ${result.stats.commits}\n`);
		process.stdout.write(`Patch versions without catalog entry: ${result.stats.missingEntries}\n`);

		verify(source, result.tip, result.checkpoints);
		git(['update-ref', targetRef, result.tip, ZERO_OID]);
		process.stdout.write(`Created branch ${options.target} at ${result.tip}\n`);
		process.stdout.write(`Source branch and working tree were not changed.\n`);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

try {
	await rewrite(parseArgs(process.argv.slice(2)));
} catch (error) {
	process.stderr.write(`${error.stack ?? error.message ?? error}\n`);
	process.exit(1);
}
