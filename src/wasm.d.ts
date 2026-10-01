// Wrangler/esbuild turns a `.wasm` import into a compiled WebAssembly.Module
// that is bundled with the Worker (CF Workers can't dynamically import wasm).
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
