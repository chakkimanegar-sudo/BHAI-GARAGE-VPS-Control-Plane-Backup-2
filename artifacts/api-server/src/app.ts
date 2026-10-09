import express, { type ErrorRequestHandler, type Express } from "express";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use(express.json({ limit: "16kb" }));
app.use(cookieParser());

app.use("/api", (req, res, next) => {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    next();
    return;
  }
  const origin = req.get("origin");
  const site = req.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    res.status(403).json({ error: "Cross-site requests are not accepted." });
    return;
  }
  if (origin) {
    try {
      if (new URL(origin).host !== req.get("host")) {
        res.status(403).json({ error: "Cross-origin requests are not accepted." });
        return;
      }
    } catch {
      res.status(403).json({ error: "Invalid request origin." });
      return;
    }
  }
  next();
});

app.use("/api", router);
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "API endpoint not found." });
});

const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  req.log.error({ errorType: error instanceof Error ? error.name : "UnknownError" }, "API request failed");
  if (res.headersSent) return;
  res.status(500).json({ error: "Internal server error." });
};
app.use(errorHandler);

export default app;
