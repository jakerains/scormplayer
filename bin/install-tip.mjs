// npm lifecycle scripts often have no terminal. Offer setup on the first interactive
// player launch instead; never start an installer from npm install, CI, or an MCP host.
if (!process.env.CI && process.env.npm_config_loglevel !== "silent") {
  console.log("SCORM Player installed. Run scormplayer setup to pick apps once for MCP with bundled review guidance, or choose on your first terminal launch.");
}
