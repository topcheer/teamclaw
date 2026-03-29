const fs = require('fs');
const f = '/app/extensions/teamclaw/src/controller/worker-provisioning.ts';
let c = fs.readFileSync(f, 'utf8');

// 1. Patch resolveCurrentTeamClawPluginRootDir to return empty when baked in
c = c.replace(
  'return path.resolve(fileURLToPath(new URL("../../", import.meta.url)));',
  'return process.env.TEAMCLAW_BAKED_IN === "true" ? "" : path.resolve(fileURLToPath(new URL("../../", import.meta.url)));'
);

// 2. Patch buildDockerBinds to guard against empty plugin dir
c = c.replace(
  'binds.unshift(`${resolveCurrentTeamClawPluginRootDir()}:${DEFAULT_DOCKER_BUNDLED_TEAMCLAW_PLUGIN_DIR}:ro`);',
  'const _pd = resolveCurrentTeamClawPluginRootDir(); if (_pd) binds.unshift(`${_pd}:${DEFAULT_DOCKER_BUNDLED_TEAMCLAW_PLUGIN_DIR}:ro`);'
);

fs.writeFileSync(f, c);
console.log('Patch applied successfully');
