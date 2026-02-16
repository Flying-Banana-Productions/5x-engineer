import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const DEFAULT_DB_PATH = ".5x/5x.db";

let instance: Database | null = null;
let instancePath: string | null = null;
let cleanupRegistered = false;

/**
 * Get or create the singleton SQLite database connection.
 * Creates the `.5x/` directory and DB file if they don't exist.
 * Sets WAL mode, foreign keys, and busy timeout on first open.
 */
export function getDb(projectRoot: string, dbPath?: string): Database {
  const resolvedPath = resolve(projectRoot, dbPath ?? DEFAULT_DB_PATH);

  if (instance && instancePath === resolvedPath) {
    return instance;
  }

  // Close any existing connection to a different path
  if (instance) {
    closeDb();
  }

  const dir = dirname(resolvedPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new Database(resolvedPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA busy_timeout=5000");

  instance = db;
  instancePath = resolvedPath;

  if (!cleanupRegistered) {
    cleanupRegistered = true;
    const cleanup = () => {
      closeDb();
    };
    process.on("exit", cleanup);
    process.on("SIGINT", () => {
      cleanup();
      process.exit(130);
    });
    process.on("SIGTERM", () => {
      cleanup();
      process.exit(143);
    });
  }

  return db;
}

/** Close the singleton database connection. Safe to call multiple times. */
export function closeDb(): void {
  if (instance) {
    try {
      instance.close();
    } catch {
      // Already closed or other error — ignore
    }
    instance = null;
    instancePath = null;
  }
}

/** Get the resolved path of the current DB instance (for diagnostics). */
export function getDbPath(): string | null {
  return instancePath;
}

/**
 * Reset internal state. Only for testing — allows fresh singleton creation.
 * @internal
 */
export function _resetForTest(): void {
  instance = null;
  instancePath = null;
}
