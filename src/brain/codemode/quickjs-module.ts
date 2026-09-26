import releaseSync from "@jitl/quickjs-wasmfile-release-sync"
// wrangler only compiles an import as WASM when its path ends in .wasm, and the
// package's "./wasm" export doesn't, so this points at the file itself.
import wasmModule from "../../../node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm"
import {
	newQuickJSWASMModuleFromVariant,
	newVariant,
	type QuickJSWASMModule,
} from "quickjs-emscripten-core"

let loading: Promise<QuickJSWASMModule> | undefined

/**
 * The QuickJS engine, compiled once per isolate. Workers can't compile WASM
 * at runtime, so the module is imported precompiled and handed to the variant.
 */
export function loadQuickJS(): Promise<QuickJSWASMModule> {
	loading ??= newQuickJSWASMModuleFromVariant(
		newVariant(releaseSync, { wasmModule }),
	)
	return loading
}
