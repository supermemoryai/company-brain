/**
 * Apply `patches/*.patch` to the installed dependency tree.
 *
 * bun applies these itself through `patchedDependencies` (see package.json),
 * but npm and pnpm do not read that field, so a tree installed with either of
 * them keeps the unpatched packages and `tsc` then rejects call sites that the
 * patch makes legal. Running this in `postinstall` makes every installer
 * produce the same tree bun would.
 *
 * Idempotent: a patch that is already applied is skipped, so the bun path
 * (which patches first) and repeated installs are both no-ops. A patch that
 * can neither be applied nor found already applied fails the install rather
 * than leaving a silently broken tree.
 */
import { execFileSync } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const patches = join(root, "patches")
const modules = join(root, "node_modules")

// `@scope%2Fname@1.2.3.patch` — the bun patch filename convention.
const nameFrom = (file) => {
	const base = file.slice(0, -".patch".length)
	const at = base.lastIndexOf("@")
	return at <= 0 ? "" : decodeURIComponent(base.slice(0, at))
}

if (!existsSync(modules)) {
	console.log("[apply-patches] no node_modules yet; nothing to patch")
	process.exit(0)
}

const git = (args) =>
	execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] })

const applied = (file, target) => {
	try {
		git(["apply", "--reverse", "--check", "-p1", "--directory", target, file])
		return true
	} catch {
		return false
	}
}

const failures = []
for (const file of readdirSync(patches).filter((f) => f.endsWith(".patch"))) {
	const name = nameFrom(file)
	const target = join("node_modules", name)
	if (!name || !existsSync(join(root, target))) {
		console.log(`[apply-patches] ${file}: ${name || "?"} is not installed, skipped`)
		continue
	}
	const path = join("patches", file)
	if (applied(path, target)) {
		console.log(`[apply-patches] ${name}: already applied`)
		continue
	}
	try {
		git(["apply", "-p1", "--directory", target, path])
		console.log(`[apply-patches] ${name}: applied ${file}`)
	} catch (error) {
		failures.push(`${file}: ${String(error.stderr || error.message).trim()}`)
	}
}

if (failures.length > 0) {
	console.error("[apply-patches] could not patch:\n" + failures.join("\n"))
	process.exit(1)
}
