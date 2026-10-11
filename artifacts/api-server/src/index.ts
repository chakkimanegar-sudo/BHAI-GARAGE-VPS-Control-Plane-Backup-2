import app from "./app";
import { logger } from "./lib/logger";
import { ensureSimulationExamples } from "./lib/seed";
import { validateEnvironment } from "./lib/env";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function start(): Promise<void> {
  validateEnvironment();
  await ensureSimulationExamples();
  const server = app.listen(port, () => {
    logger.info({ port }, "Server listening");
  });
  server.on("error", (err) => {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  });
  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

start().catch((error: unknown) => {
  logger.error({ errorType: error instanceof Error ? error.name : "UnknownError" }, "API startup failed");
  process.exit(1);
});
