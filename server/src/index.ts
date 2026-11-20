import { startServer } from "./app";

// Local convenience: pick up a .env next to package.json if there is one.
// On Render the variables come from the dashboard and no file exists.
try {
  (process as unknown as { loadEnvFile?: () => void }).loadEnvFile?.();
} catch {
  /* no .env: fine */
}

const port = Number(process.env.PORT) || 2567;
startServer(port)
  .then((s) => console.log(`[teapot] listening on http://localhost:${s.port}`))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
