import { createPlugin } from './plugin'

// Signal K loads a plugin with `require(pkg)` and calls it with the server API:
// the module itself must be the factory (CommonJS `module.exports`).
export = createPlugin
