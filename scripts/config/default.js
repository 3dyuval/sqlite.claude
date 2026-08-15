const { join } = require("path");
const { homedir } = require("os");

module.exports = function ({ defer }) {
  const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  const xdgData = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");

  return {
    embedBaseUrl: process.env.OLLAMA_URL,
    embedModel: undefined,
    embedDim: 768,
    chunkSize: 1000,
    minChunkTokens: 100,
    openaiApiKey: undefined,

    claudeDir: join(xdgConfig, "claude"),
    historyFile: defer((cfg) => join(cfg.claudeDir, "history.jsonl")),
    projectsDir: defer((cfg) => join(cfg.claudeDir, "projects")),

    dataDir: join(xdgData, "claude-sql"),
    dbPath: defer((cfg) => join(cfg.dataDir, "claude.sqlite")),
  };
};
